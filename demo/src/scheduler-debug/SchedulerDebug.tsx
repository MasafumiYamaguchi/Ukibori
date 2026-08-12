import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { createScene } from "ukibori-renderer";
import { GpuScenePipeline } from "ukibori-renderer";
import type {
  GpuCanvasContextLike,
  GpuPipelineDeviceLike,
  GpuScenePipelineFrameStats,
  InvalidationReport,
  PartialPlanReport,
  PipelineStage,
} from "ukibori-renderer";

/**
 * #31+#32 scheduler debug view: a human-drivable demo of the dirty-pass
 * scheduler and the #32 conservative tile planner. Every button triggers a
 * different invalidation class and the panel shows the dirty reasons,
 * executed/skipped passes, the PARTIAL/FULL planning report (tile grid,
 * dirty tile/texel counts, ACTUAL candidate/culled surfaces, decision
 * and reason, binning overhead) and allocations/uploaded bytes/dispatches/
 * wall-clock host timings of the last frame plus cumulative totals.
 *
 * The overlay canvas draws the deterministic tile grid, the dirty texel
 * rect (red) and the dispatched band (blue) of the last planned frame, so
 * a human can see exactly which region the scheduler recomputed.
 *
 * All durations are labeled HOST ms (wall clock around the host-side device
 * calls); no GPU timestamps are fabricated. The candidate/culled counts are
 * ACTUAL for the height composition stage: on a partial frame the compose
 * shaders iterate ONLY the band's candidate ORIGINAL surface indices
 * (packed into the reused maskMeta buffer); culled surfaces are genuinely
 * excluded from the per-texel loops. The normal/shadow/lighting stages
 * perform no per-texel surface iteration.
 */

interface SceneCfg {
  material: "silicone" | "matte" | "metal";
  elevation: number;
  light: { x: number; y: number; z: number };
  intensity: number;
  /** button top-left; "btnOffset" edits are the #32 small/broad edit demos */
  btn: { x: number; y: number };
}

interface LiveState {
  pipeline: GpuScenePipeline | null;
  device: unknown;
  context: GpuCanvasContextLike | null;
  canvasFormat: string;
}

const DEFAULT_SCENE: SceneCfg = {
  material: "silicone",
  elevation: 4,
  light: { x: -0.6, y: -0.8, z: 1 },
  intensity: 1,
  btn: { x: 30, y: 12 },
};

// Bounded shadow maxDistance keeps the #32 down-light halo small enough
// that a small local edit takes the partial path (the default scene-
// diagonal maxDistance would legitimately force the full path).
const DEMO_SHADOW = { maxDistance: 18, stepSize: 0.5, bias: 0.5 };

function makeScene(cfg: SceneCfg) {
  return createScene({
    width: 96,
    height: 180,
    surfaces: [
      {
        id: "panel",
        position: { x: 0, y: 0 },
        size: { x: 96, y: 180 },
        elevation: 0,
        thickness: 0,
        shape: { kind: "roundedRect", radius: 0 },
        profile: { kind: "flat" },
        material: "matte",
        castsShadow: false,
        receivesShadow: true,
      },
      {
        id: "btn",
        position: cfg.btn,
        size: { x: 36, y: 32 },
        elevation: cfg.elevation,
        thickness: 2,
        bevelWidth: 3,
        shape: { kind: "roundedRect", radius: 8 },
        profile: { kind: "bevel" },
        material: cfg.material,
        castsShadow: true,
        receivesShadow: true,
      },
      {
        id: "anchor",
        position: { x: 10, y: 150 },
        size: { x: 14, y: 14 },
        elevation: 1,
        thickness: 1,
        shape: { kind: "roundedRect", radius: 3 },
        profile: { kind: "flat" },
        material: "matte",
        castsShadow: false,
        receivesShadow: true,
      },
    ],
    light: { direction: cfg.light, intensity: cfg.intensity },
  });
}

/** Narrow structural navigation: the demo never calls navigator.gpu itself. */
interface GpuNavigatorLike {
  requestAdapter(): Promise<{ requestDevice(): Promise<unknown> } | null>;
  getPreferredCanvasFormat(): string;
}

function gpuNavigator(): GpuNavigatorLike | null {
  const nav = navigator as unknown as { gpu?: GpuNavigatorLike };
  return nav.gpu ?? null;
}

const STAGES: readonly PipelineStage[] = [
  "upload",
  "height",
  "normal",
  "shadow",
  "lighting",
  "presentation",
];

function reportToLines(report: InvalidationReport): string[] {
  return [
    `reasons: ${report.reasons.length === 0 ? "(none — byte-identical)" : report.reasons.join(", ")}`,
    `retained: ${String(report.retained)}`,
    `executed: ${report.executed.length === 0 ? "(none)" : report.executed.join(", ")}`,
    `skipped: ${report.skipped.length === 0 ? "(none)" : report.skipped.join(", ")}`,
  ];
}

function planToLines(planning: PartialPlanReport): string[] {
  return [
    `decision: ${planning.mode} (${planning.reason})`,
    `tile ${planning.tileSize}px grid: ${planning.dirtyTileCount}/${planning.totalTileCount} dirty tiles`,
    `dirty ${planning.dirtyTexels} / dispatch ${planning.dispatchTexels} / total ${planning.totalTexels} texels`,
    `actual candidates ${planning.candidateSurfaceCount} / culled ${planning.culledSurfaceCount}`,
    `binning overhead ${planning.planningHostMs.toFixed(3)} host ms (separate from GPU work)`,
  ];
}

/** Draw the tile grid, dirty rect and dispatch band on the overlay canvas. */
function drawOverlay(
  canvas: HTMLCanvasElement | null,
  width: number,
  height: number,
  planning: PartialPlanReport,
): void {
  if (canvas === null) {
    return;
  }
  if (canvas.width !== width) {
    canvas.width = width;
  }
  if (canvas.height !== height) {
    canvas.height = height;
  }
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    return;
  }
  ctx.clearRect(0, 0, width, height);
  // deterministic tile grid
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= width; x += planning.tileSize) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, height);
  }
  for (let y = 0; y <= height; y += planning.tileSize) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(width, y + 0.5);
  }
  ctx.stroke();
  if (planning.dirtyRect === null) {
    return;
  }
  const { x, y, width: w, height: h } = planning.dirtyRect;
  // true 2D dirty rect
  ctx.fillStyle = "rgba(255,64,64,0.30)";
  ctx.strokeStyle = "rgba(255,64,64,0.9)";
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  // dispatched band (full-width rows covering the dirty tiles)
  if (planning.band !== null) {
    ctx.strokeStyle = "rgba(64,160,255,0.9)";
    ctx.lineWidth = 2;
    ctx.strokeRect(0.5, planning.band.y0 + 0.5, width - 1, planning.band.y1 - planning.band.y0);
  }
}

export function SchedulerDebug(): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const live = useRef<LiveState>({ pipeline: null, device: null, context: null, canvasFormat: "" });
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<string>("initializing…");
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<GpuScenePipelineFrameStats | null>(null);
  const [cfg, setCfg] = useState<SceneCfg>(DEFAULT_SCENE);
  const [dpr, setDpr] = useState(1);
  const [tileSize, setTileSize] = useState(32);
  const [shadowBias, setShadowBias] = useState(0.5);
  const [ambient, setAmbient] = useState(0.08);
  const [shadowAlpha, setShadowAlpha] = useState(0.3);
  const [lastFullDispatch, setLastFullDispatch] = useState<number | null>(null);

  // One fresh device + canvas + pipeline for the whole page; the recovery
  // seam ("force full") disposes it and builds a replacement.
  const buildPipeline = useCallback(async (): Promise<void> => {
    const gpu = gpuNavigator();
    if (gpu === null) {
      throw new Error("WebGPU is not available in this browser");
    }
    const adapter = await gpu.requestAdapter();
    if (adapter === null) {
      throw new Error("no WebGPU adapter available");
    }
    const device = await adapter.requestDevice();
    const canvas = canvasRef.current;
    if (canvas === null) {
      throw new Error("canvas missing");
    }
    canvas.width = 0;
    canvas.height = 0;
    const context = canvas.getContext("webgpu") as unknown as GpuCanvasContextLike;
    const canvasFormat = gpu.getPreferredCanvasFormat();
    const pipeline = new GpuScenePipeline(
      device as unknown as GpuPipelineDeviceLike,
      context,
      canvasFormat as never,
    );
    live.current = { pipeline, device, context, canvasFormat };
  }, []);

  const disposePipeline = useCallback((): void => {
    live.current.pipeline?.dispose();
    live.current = { pipeline: null, device: null, context: null, canvasFormat: "" };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await buildPipeline();
        if (cancelled) {
          disposePipeline();
          return;
        }
        const stats = live.current.pipeline!.render({
          scene: makeScene(DEFAULT_SCENE),
          dpr: 1,
          shadowOptions: DEMO_SHADOW,
          tileSize: 32,
          debugReadback: false,
        });
        setLast(stats);
        setLastFullDispatch(stats.frame.dispatchCount);
        setReady(true);
        setStatus(
          `WebGPU ready · first frame (full chain) · ${stats.renderWidth}x${stats.renderHeight} @ dpr ${stats.dpr}`,
        );
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
      disposePipeline();
    };
  }, [buildPipeline, disposePipeline]);

  const render = useCallback(
    (partial: {
      scene?: SceneCfg;
      dpr?: number;
      tileSize?: number;
      shadowBias?: number;
      ambient?: number;
      shadowAlpha?: number;
      repaint?: boolean;
      forceFull?: boolean;
    }): void => {
      void (async () => {
        try {
          const nextCfg = partial.scene ?? cfg;
          const nextDpr = partial.dpr ?? dpr;
          const nextTile = partial.tileSize ?? tileSize;
          const nextBias = partial.shadowBias ?? shadowBias;
          const nextAmbient = partial.ambient ?? ambient;
          const nextAlpha = partial.shadowAlpha ?? shadowAlpha;
          if (partial.forceFull === true) {
            disposePipeline();
            await buildPipeline();
          }
          const pipeline = live.current.pipeline;
          if (pipeline === null) {
            throw new Error("pipeline unavailable");
          }
          const stats = pipeline.render({
            scene: makeScene(nextCfg),
            dpr: nextDpr,
            shadowOptions: { ...DEMO_SHADOW, bias: nextBias },
            lightingOptions: { ambient: nextAmbient },
            compositeOptions: { shadowAlpha: nextAlpha },
            tileSize: nextTile,
            repaint: partial.repaint === true,
          });
          if (stats.invalidation.executed.length === 6 && stats.planning.mode === "full") {
            setLastFullDispatch(stats.frame.dispatchCount);
          }
          setCfg(nextCfg);
          setDpr(nextDpr);
          setTileSize(nextTile);
          setShadowBias(nextBias);
          setAmbient(nextAmbient);
          setShadowAlpha(nextAlpha);
          setLast(stats);
          setStatus(
            `frame #${stats.totals.frames} · ${stats.renderWidth}x${stats.renderHeight} @ dpr ${stats.dpr} · ` +
              `${stats.invalidation.executed.length === 0 ? "fully retained" : `executed ${stats.invalidation.executed.join("+")}`} · ` +
              `plan ${stats.planning.mode} (${stats.planning.reason})`,
          );
          drawOverlay(overlayRef.current, stats.renderWidth, stats.renderHeight, stats.planning);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      })();
    },
    [buildPipeline, disposePipeline, cfg, dpr, tileSize, shadowBias, ambient, shadowAlpha],
  );

  const run = useCallback(
    (partial: {
      scene?: SceneCfg;
      dpr?: number;
      tileSize?: number;
      shadowBias?: number;
      ambient?: number;
      shadowAlpha?: number;
      repaint?: boolean;
      forceFull?: boolean;
    }) => () => render(partial),
    [render],
  );

  const partialCompareNote =
    last !== null && lastFullDispatch !== null && last.planning.mode === "partial"
      ? ` (last full frame dispatched ${lastFullDispatch} compute calls; this partial frame ${last.frame.dispatchCount} calls at a smaller workgroup count)`
      : "";

  return (
    <main>
      <h1>Ukibori scheduler debug — #31 dirty scheduling + #32 tile planner</h1>
      {error !== null ? (
        <p style={{ color: "#a11" }}>
          Error: {error} · <a href="/renderer-debug.html">renderer debug</a>
        </p>
      ) : (
        <>
          <section>
            <h2>Pipeline</h2>
            <p className="note">
              <span className="badge">{status}</span>
              <span className="badge">host ms only — no GPU timestamps</span>
            </p>
            <div style={{ position: "relative", display: "inline-block" }}>
              <canvas ref={canvasRef} width={96} height={180} />
              <canvas
                ref={overlayRef}
                width={96}
                height={180}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  pointerEvents: "none",
                  imageRendering: "pixelated",
                }}
              />
            </div>
            <p className="note">
              Overlay: white = deterministic tile grid · red = true dirty texel rect · blue =
              dispatched band (full-width rows covering the dirty tiles)
            </p>
          </section>
          <section>
            <h2>Trigger an invalidation</h2>
            <p className="note">
              Each button changes exactly one input class. The scene object is recreated on every
              render call — only the stable fingerprints and the exact byte diff matter. Small
              local edits take the #32 partial path (only the dirty band dispatches); broad edits
              and global light/material changes fall back to the full path.
            </p>
            <div className="btn-row">
              <button type="button" onClick={run({})} disabled={!ready}>
                Re-render unchanged
              </button>
              <button
                type="button"
                onClick={run({ repaint: true })}
                disabled={!ready}
                title="re-present the retained frame from retained outputs"
              >
                Re-present retained
              </button>
              <button
                type="button"
                onClick={run({ scene: { ...cfg, btn: { x: cfg.btn.x + 2, y: cfg.btn.y + 1 } } })}
                disabled={!ready}
                title="#32: a small local edit — the planner should choose PARTIAL"
              >
                Small local edit (btn +2px)
              </button>
              <button
                type="button"
                onClick={run({ scene: { ...cfg, btn: { x: 40, y: 120 } } })}
                disabled={!ready}
                title="#32: a broad edit spanning many tile rows — the planner should choose FULL"
              >
                Broad edit (btn far)
              </button>
              <button
                type="button"
                onClick={run({ forceFull: true })}
                disabled={!ready}
                title="dispose and rebuild a fresh pipeline (the recovery seam / forced-full comparison)"
              >
                Forced-full recompute (fresh pipeline)
              </button>
              <button
                type="button"
                onClick={run({
                  scene: {
                    ...cfg,
                    light: { x: cfg.light.x * -1, y: cfg.light.y * -1, z: cfg.light.z },
                  },
                })}
                disabled={!ready}
              >
                Move light (full fallback)
              </button>
              <button
                type="button"
                onClick={run({
                  scene: {
                    ...cfg,
                    material: cfg.material === "metal" ? "silicone" : cfg.material === "silicone" ? "matte" : "metal",
                    elevation: cfg.elevation + 1,
                  },
                })}
                disabled={!ready}
              >
                Material / geometry (scene)
              </button>
              <button
                type="button"
                onClick={run({ shadowBias: shadowBias === 0.5 ? 0.25 : 0.5 })}
                disabled={!ready}
              >
                Shadow options (bias {shadowBias === 0.5 ? "0.5 → 0.25" : "0.25 → 0.5"})
              </button>
              <button
                type="button"
                onClick={run({ ambient: ambient === 0.08 ? 0.3 : 0.08 })}
                disabled={!ready}
              >
                Ambient (lighting {ambient === 0.08 ? "0.08 → 0.3" : "0.3 → 0.08"})
              </button>
              <button
                type="button"
                onClick={run({ shadowAlpha: shadowAlpha === 0.3 ? 0.6 : 0.3 })}
                disabled={!ready}
              >
                Composite (presentation {shadowAlpha === 0.3 ? "0.3 → 0.6" : "0.6 → 0.3"})
              </button>
              <button
                type="button"
                onClick={run({ dpr: dpr === 1 ? 2 : 1 })}
                disabled={!ready}
              >
                Resize (DPR {dpr === 1 ? "1 → 2" : "2 → 1"})
              </button>
            </div>
            <p className="note">
              #32 tile size (configurable, bounded 8..512, default 64):{" "}
              <select
                value={tileSize}
                onChange={(event) => run({ tileSize: Number(event.target.value) })()}
                disabled={!ready}
              >
                <option value={8}>8</option>
                <option value={16}>16</option>
                <option value={32}>32</option>
                <option value={64}>64</option>
                <option value={128}>128</option>
              </select>
            </p>
            <p className="note">
              current: material {cfg.material} · elevation {cfg.elevation} · light{" "}
              {cfg.light.x.toFixed(2)},{cfg.light.y.toFixed(2)},{cfg.light.z.toFixed(2)} · btn{" "}
              {cfg.btn.x},{cfg.btn.y} · dpr {dpr} · tile {tileSize} · shadow bias {shadowBias} ·
              ambient {ambient} · composite shadowAlpha {shadowAlpha}
            </p>
          </section>
          {last !== null ? (
            <section>
              <h2>Last frame — scheduler report, #32 planning &amp; profiling</h2>
              <p className="note">{reportToLines(last.invalidation).join(" · ")}</p>
              <h3>#32 tile planning</h3>
              <p className="note">
                {planToLines(last.planning).join(" · ")}
                {partialCompareNote}
              </p>
              <table>
                <thead>
                  <tr>
                    <th>stage</th>
                    <th>executed</th>
                    <th>host ms</th>
                    <th>new allocs</th>
                    <th>allocs held</th>
                    <th>uploaded B</th>
                    <th>dispatches</th>
                  </tr>
                </thead>
                <tbody>
                  {STAGES.map((stage) => (
                    <tr key={stage}>
                      <td>{stage}</td>
                      <td>{last.invalidation.executed.includes(stage) ? "yes" : "—"}</td>
                      <td>{last.frame.passDurations[stage].toFixed(3)}</td>
                      <td>{stageStatsNewAllocations(last, stage)}</td>
                      <td>{stageStatsAllocations(last, stage)}</td>
                      <td>{stage === "upload" ? last.upload.bytesUploaded : 0}</td>
                      <td>{stageDispatchCount(last, stage)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="note">
                frame: {last.frame.newAllocations} new allocations · {last.frame.bytesUploaded}{" "}
                bytes uploaded · {last.frame.dispatchCount} dispatches · {last.frame.submissions}{" "}
                submissions · {last.frame.hostMs.toFixed(3)} host ms
              </p>
              <p className="note">
                cumulative: {last.totals.frames} frames ({last.totals.skippedFrames} fully
                retained) · {last.totals.presents} re-presents · {last.totals.newAllocations}{" "}
                allocations · {last.totals.bytesUploaded} bytes · {last.totals.dispatches}{" "}
                dispatches · {last.totals.submissions} submissions ·{" "}
                {last.totals.hostMs.toFixed(3)} host ms
              </p>
            </section>
          ) : null}
        </>
      )}
    </main>
  );
}

function stageStatsNewAllocations(
  stats: GpuScenePipelineFrameStats,
  stage: PipelineStage,
): number {
  switch (stage) {
    case "upload":
      return stats.upload.newAllocations;
    case "height":
      return stats.height.newAllocations;
    case "normal":
      return stats.normal.newAllocations;
    case "shadow":
      return stats.shadow.newAllocations;
    case "lighting":
      return stats.lighting.newAllocations;
    case "presentation":
      return stats.presentation.newAllocations;
  }
}

function stageStatsAllocations(stats: GpuScenePipelineFrameStats, stage: PipelineStage): number {
  switch (stage) {
    case "upload":
      return stats.upload.allocationCount;
    case "height":
      return stats.height.allocationCount;
    case "normal":
      return stats.normal.allocationCount;
    case "shadow":
      return stats.shadow.allocationCount;
    case "lighting":
      return stats.lighting.allocationCount;
    case "presentation":
      return stats.presentation.allocationCount;
  }
}

function stageDispatchCount(stats: GpuScenePipelineFrameStats, stage: PipelineStage): number {
  switch (stage) {
    case "height":
      return stats.height.maskSdfPasses + stats.height.composePasses;
    case "normal":
      return stats.normal.workgroupCountX > 0 ? 1 : 0;
    case "shadow":
      return stats.shadow.workgroupCountX > 0 ? 1 : 0;
    case "lighting":
      return stats.lighting.workgroupCountX > 0 ? 1 : 0;
    default:
      return 0;
  }
}

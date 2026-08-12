import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { createScene } from "ukibori-renderer";
import { GpuScenePipeline } from "ukibori-renderer";
import type {
  GpuCanvasContextLike,
  GpuPipelineDeviceLike,
  GpuScenePipelineFrameStats,
  InvalidationReport,
  PipelineStage,
} from "ukibori-renderer";

/**
 * #31 scheduler debug view: a human-drivable demo of the dirty-pass
 * scheduler. Every button triggers a different invalidation class (unchanged
 * / light / material-geometry / shadow / lighting-ambient / composite /
 * resize / forced-full / retained repaint) and the panel shows the dirty
 * reasons, executed/skipped passes, allocations, uploaded bytes, dispatches
 * and wall-clock host timings of the last frame plus cumulative totals.
 *
 * All durations are labeled HOST ms (wall clock around the host-side device
 * calls); no GPU timestamps are fabricated.
 */

interface SceneCfg {
  material: "silicone" | "matte" | "metal";
  elevation: number;
  light: { x: number; y: number; z: number };
  intensity: number;
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
};

function makeScene(cfg: SceneCfg) {
  return createScene({
    width: 96,
    height: 60,
    surfaces: [
      {
        id: "panel",
        position: { x: 0, y: 0 },
        size: { x: 96, y: 60 },
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
        position: { x: 30, y: 12 },
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

export function SchedulerDebug(): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const live = useRef<LiveState>({ pipeline: null, device: null, context: null, canvasFormat: "" });
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<string>("initializing…");
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<GpuScenePipelineFrameStats | null>(null);
  const [cfg, setCfg] = useState<SceneCfg>(DEFAULT_SCENE);
  const [dpr, setDpr] = useState(1);
  const [shadowBias, setShadowBias] = useState(0.5);
  const [ambient, setAmbient] = useState(0.08);
  const [shadowAlpha, setShadowAlpha] = useState(0.3);

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
          debugReadback: false,
        });
        setLast(stats);
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
            shadowOptions: { bias: nextBias },
            lightingOptions: { ambient: nextAmbient },
            compositeOptions: { shadowAlpha: nextAlpha },
            repaint: partial.repaint === true,
          });
          setCfg(nextCfg);
          setDpr(nextDpr);
          setShadowBias(nextBias);
          setAmbient(nextAmbient);
          setShadowAlpha(nextAlpha);
          setLast(stats);
          setStatus(
            `frame #${stats.totals.frames} · ${stats.renderWidth}x${stats.renderHeight} @ dpr ${stats.dpr} · ` +
              `${stats.invalidation.executed.length === 0 ? "fully retained" : `executed ${stats.invalidation.executed.join("+")}`}`,
          );
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      })();
    },
    [buildPipeline, disposePipeline, cfg, dpr, shadowBias, ambient, shadowAlpha],
  );

  const run = useCallback(
    (partial: {
      scene?: SceneCfg;
      dpr?: number;
      shadowBias?: number;
      ambient?: number;
      shadowAlpha?: number;
      repaint?: boolean;
      forceFull?: boolean;
    }) => () => render(partial),
    [render],
  );

  return (
    <main>
      <h1>Ukibori scheduler debug — #31 dirty-pass scheduling</h1>
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
            <canvas ref={canvasRef} width={96} height={60} />
          </section>
          <section>
            <h2>Trigger an invalidation</h2>
            <p className="note">
              Each button changes exactly one input class, so the reported dirty reasons show the
              dependency graph in action. The scene object is recreated on every render call —
              only the stable fingerprints matter.
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
                onClick={run({
                  scene: {
                    ...cfg,
                    light: { x: cfg.light.x * -1, y: cfg.light.y * -1, z: cfg.light.z },
                  },
                })}
                disabled={!ready}
              >
                Move light (scene)
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
              <button
                type="button"
                onClick={run({ forceFull: true })}
                disabled={!ready}
                title="dispose and rebuild a fresh pipeline (the recovery seam)"
              >
                Force full recompute (fresh pipeline)
              </button>
            </div>
            <p className="note">
              current: material {cfg.material} · elevation {cfg.elevation} · light{" "}
              {cfg.light.x.toFixed(2)},{cfg.light.y.toFixed(2)},{cfg.light.z.toFixed(2)} · dpr {dpr}{" "}
              · shadow bias {shadowBias} · ambient {ambient} · composite shadowAlpha {shadowAlpha}
            </p>
          </section>
          {last !== null ? (
            <section>
              <h2>Last frame — scheduler report &amp; profiling</h2>
              <p className="note">{reportToLines(last.invalidation).join(" · ")}</p>
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

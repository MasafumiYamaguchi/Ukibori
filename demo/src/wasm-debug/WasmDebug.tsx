import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  WasmCpuPipeline,
  createRenderer,
  createScene,
  lightScene,
  resetWasmSelectionCache,
  selectWasmBackend,
  GpuScenePipeline,
} from "ukibori-renderer";
import type {
  GpuCanvasContextLike,
  GpuPipelineDeviceLike,
  LightingOptions,
  Scene,
  WasmRenderResult,
  WasmSelectionReport,
} from "ukibori-renderer";

/**
 * #33 WASM diagnostics page — browser-visible WASM support, load/probe/
 * selection state, the ACTUAL WASM stage with provenance, transfer sizes,
 * memory pages/growth, cancellation/disposal status, parity vs the
 * TypeScript oracle, and honest TS/WASM/WebGPU benchmark rows for
 * representative small/large scenes.
 *
 * Honesty rules (mirroring the renderer's capability policy):
 *
 * - durations are HOST wall-clock (ms); no GPU timestamps are fabricated
 * - a result is labeled WASM only when its stage provenance says the normal
 *   stage actually ran in WASM
 * - WebGPU benchmark rows report "unavailable" when no adapter exists —
 *   never fake timings
 * - benchmark timings are displayed as informational (non-gating); parity,
 *   lifecycle and selection rules are the gates (verified by the test
 *   suites and the real-Chrome harness)
 */

interface SceneCfg {
  width: number;
  height: number;
}

const SMALL: SceneCfg = { width: 96, height: 60 };
const LARGE: SceneCfg = { width: 480, height: 300 };
const SCENES: Record<string, SceneCfg> = { small: SMALL, large: LARGE };
const DEFAULT_ITERATIONS = 5;

const BENCH_OPTIONS = { shadow: { maxDistance: 18, stepSize: 0.5, bias: 0.5 } };

/**
 * Build a representative scene. `variant` toggles geometry + light so two
 * variants ALWAYS invalidate the full render chain when alternated — the
 * WebGPU benchmark samples must be FULL renders, never retained frames
 * (retained frames would skip all compute and understate GPU time).
 */
function makeScene(cfg: SceneCfg, variant: 0 | 1 = 0): Scene {
  const shift = variant === 0 ? 0 : 1;
  return createScene({
    width: cfg.width,
    height: cfg.height,
    surfaces: [
      {
        id: "panel",
        position: { x: 0, y: 0 },
        size: { x: cfg.width, y: cfg.height },
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
        position: { x: Math.round(cfg.width * 0.28) + shift * 3, y: Math.round(cfg.height * 0.18) + shift * 2 },
        size: { x: Math.round(cfg.width * 0.4), y: Math.round(cfg.height * 0.5) },
        elevation: 4 + shift,
        thickness: 2,
        bevelWidth: 3,
        shape: { kind: "roundedRect", radius: 8 },
        profile: { kind: "bevel" },
        material: "silicone",
        castsShadow: true,
        receivesShadow: true,
      },
      {
        id: "badge",
        position: { x: Math.round(cfg.width * 0.62) + shift * 2, y: Math.round(cfg.height * 0.55) + shift },
        size: { x: Math.round(cfg.width * 0.16), y: Math.round(cfg.height * 0.16) },
        elevation: 8,
        thickness: 1.5,
        bevelWidth: 1,
        shape: { kind: "roundedRect", radius: 3 },
        profile: { kind: "bevel" },
        material: "metal",
        castsShadow: true,
        receivesShadow: true,
      },
    ],
    light: {
      direction: variant === 0 ? { x: -0.6, y: -0.8, z: 1 } : { x: 0.6, y: 0.7, z: 1 },
      intensity: 1,
    },
    environment: { intensity: 0.4 },
    exposure: 1,
  });
}

function drawColor(canvas: HTMLCanvasElement | null, buffer: WasmRenderResult["color"]): void {
  if (canvas === null) {
    return;
  }
  canvas.width = buffer.spec.width;
  canvas.height = buffer.spec.height;
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    return;
  }
  const image = ctx.createImageData(buffer.spec.width, buffer.spec.height);
  image.data.set(new Uint8ClampedArray(buffer.data.buffer));
  ctx.putImageData(image, 0, 0);
}

interface ParityResult {
  ok: boolean;
  maxNormalDelta: number;
  maxColorDelta: number;
}

function compareParity(wasm: WasmRenderResult, oracle: ReturnType<typeof lightScene>): ParityResult {
  const normalA = new Uint8Array(wasm.normal.data.buffer);
  const normalB = new Uint8Array(oracle.normal.data.buffer);
  const colorA = new Uint8Array(wasm.color.data.buffer);
  const colorB = new Uint8Array(oracle.color.data.buffer);
  let maxNormalDelta = 0;
  let maxColorDelta = 0;
  for (let i = 0; i < normalA.length; i++) {
    maxNormalDelta = Math.max(maxNormalDelta, Math.abs(normalA[i] - normalB[i]));
  }
  for (let i = 0; i < colorA.length; i++) {
    maxColorDelta = Math.max(maxColorDelta, Math.abs(colorA[i] - colorB[i]));
  }
  return { ok: maxNormalDelta === 0 && maxColorDelta === 0, maxNormalDelta, maxColorDelta };
}

interface BenchmarkRow {
  backend: string;
  smallMs: number | null;
  largeMs: number | null;
  note: string;
}

/** Honest host wall-clock benchmark of one backend over one scene. */
async function timeBackend(
  backend: "ts" | "wasm",
  cfg: SceneCfg,
  iterations: number,
  pipeline: WasmCpuPipeline | null,
): Promise<number | null> {
  const scene = makeScene(cfg);
  const options: LightingOptions = { shadow: BENCH_OPTIONS.shadow };
  if (backend === "ts") {
    // warmup + measured iterations of the pure TypeScript oracle
    lightScene(scene, options);
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      lightScene(scene, options);
    }
    return (performance.now() - start) / iterations;
  }
  if (pipeline === null) {
    return null;
  }
  await pipeline.render({ scene, lighting: options });
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    await pipeline.render({ scene, lighting: options });
  }
  return (performance.now() - start) / iterations;
}

interface GpuNavigatorLike {
  requestAdapter(): Promise<{ requestDevice(): Promise<unknown> } | null>;
  getPreferredCanvasFormat(): string;
}

function gpuNavigator(): GpuNavigatorLike | null {
  const nav = navigator as unknown as { gpu?: GpuNavigatorLike };
  return nav.gpu ?? null;
}

export function WasmDebug(): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gpuCanvasRef = useRef<HTMLCanvasElement>(null);
  const pipelineRef = useRef<WasmCpuPipeline | null>(null);
  const gpuPipelineRef = useRef<{ pipeline: GpuScenePipeline; device: unknown; context: GpuCanvasContextLike; format: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [selection, setSelection] = useState<WasmSelectionReport | null>(null);
  const [selectionMode, setSelectionMode] = useState<"auto" | "wasm" | "cpu">("auto");
  const [renderPath, setRenderPath] = useState<"wasm" | "ts">("wasm");
  const [lastRender, setLastRender] = useState<WasmRenderResult | null>(null);
  const [parity, setParity] = useState<ParityResult | null>(null);
  const [lifecycle, setLifecycle] = useState("initializing…");
  const [policyDemo, setPolicyDemo] = useState<string | null>(null);
  const [benchmarks, setBenchmarks] = useState<BenchmarkRow[] | null>(null);
  const [benchmarkRunning, setBenchmarkRunning] = useState(false);
  const [iterations, setIterations] = useState(DEFAULT_ITERATIONS);
  const [error, setError] = useState<string | null>(null);

  // ---- init: cached decision + first render ----
  // StrictMode runs effects twice: every selection/pipeline here owns an
  // INDEPENDENT kernel instance (shared compilation), so the first effect's
  // cleanup disposing its pipeline never invalidates the second effect's
  // pipeline. A stale effect that finishes after its cleanup never
  // overwrites the live pipelineRef.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const report = await selectWasmBackend({});
        if (cancelled) {
          report.kernel?.dispose();
          return;
        }
        setSelection(report);
        if (report.selected === "wasm") {
          const pipeline = await WasmCpuPipeline.load({ kernel: report.kernel ?? undefined, selection: report });
          if (cancelled) {
            pipeline.dispose();
            return;
          }
          pipelineRef.current = pipeline;
          const scene = makeScene(SMALL);
          const result = await pipeline.render({ scene, lighting: { shadow: BENCH_OPTIONS.shadow } });
          if (cancelled) {
            return;
          }
          setLastRender(result);
          setParity(compareParity(result, lightScene(scene, { shadow: BENCH_OPTIONS.shadow })));
          drawColor(canvasRef.current, result.color);
          setLifecycle(`ready · first render via ${result.wasmStages.normal === "wasm" ? "WASM normal stage" : "TypeScript"}`);
        } else {
          setLifecycle(`selection fell back to TypeScript (${report.fallbackReason})`);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
      pipelineRef.current?.dispose();
      pipelineRef.current = null;
    };
  }, []);

  const runSelection = useCallback(async (mode: "auto" | "wasm" | "cpu"): Promise<void> => {
    setSelectionMode(mode);
    setError(null);
    try {
      const report = await selectWasmBackend(
        mode === "auto" ? {} : { force: mode },
      );
      setSelection(report);
      setLifecycle(
        `selection: ${report.selected} (${report.stage ?? "no WASM stage"}) · ` +
          `fallback reason: ${report.fallbackReason ?? "none"}`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const renderScene = useCallback(
    async (withAbortMs: number | null): Promise<void> => {
      setError(null);
      const scene = makeScene(SMALL);
      const options: LightingOptions = { shadow: BENCH_OPTIONS.shadow };
      try {
        if (renderPath === "wasm") {
          const pipeline = pipelineRef.current;
          if (pipeline === null) {
            throw new Error("WASM pipeline unavailable (selection fell back to TypeScript?)");
          }
          abortRef.current?.abort();
          const controller = new AbortController();
          abortRef.current = controller;
          if (withAbortMs !== null) {
            setTimeout(() => controller.abort(), withAbortMs);
          }
          const result = await pipeline.render({
            scene,
            lighting: options,
            signal: controller.signal,
          });
          setLastRender(result);
          setParity(compareParity(result, lightScene(scene, options)));
          drawColor(canvasRef.current, result.color);
          const s = result.wasmStats;
          setLifecycle(
            `render ok · total ${result.totalMs.toFixed(2)} ms · kernel ${s.kernelMs.toFixed(2)} ms · ` +
              `transfer ${s.transferMs.toFixed(2)} ms · js→wasm ${s.jsToWasmBytes} B · ` +
              `wasm→js ${s.wasmToJsBytes} B · ${s.memoryPages} pages · ${s.growthCount} growth`,
          );
        } else {
          const oracle = lightScene(scene, options);
          setLifecycle("TypeScript render ok · all stages typescript (no WASM executed)");
          void oracle;
        }
      } catch (e) {
        const err = e as Error;
        if (err.name === "AbortError") {
          setLifecycle("render CANCELLED (AbortError) — no result published; the previous frame stays");
        } else {
          setError(err.message);
          setLifecycle(`render failed: ${err.message}`);
        }
      } finally {
        if (withAbortMs !== null) {
          abortRef.current = null;
        }
      }
    },
    [renderPath],
  );

  const disposePipeline = useCallback((): void => {
    pipelineRef.current?.dispose();
    pipelineRef.current = null;
    setLifecycle("pipeline DISPOSED (idempotent) · new renders will reject until re-created");
  }, []);

  const recreatePipeline = useCallback(async (): Promise<void> => {
    try {
      const report = await selectWasmBackend({ force: "wasm" });
      const pipeline = await WasmCpuPipeline.load({ kernel: report.kernel ?? undefined, selection: report });
      pipelineRef.current = pipeline;
      setSelection(report);
      setLifecycle("pipeline re-created (fresh kernel after disposal)");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const runPolicyDemo = useCallback(
    async (backend: "auto" | "webgpu" | "wasm" | "cpu"): Promise<void> => {
      try {
        const created = await createRenderer({ backend, wasm: {} });
        setPolicyDemo(
          `createRenderer({ backend: "${backend}" }) → kind ${created.backend.kind} · ` +
            `compute ${created.backend.capabilities.compute} · ` +
            (created.wasmSelection === null
              ? "no WASM selection evidence (WebGPU won or CPU-only)"
              : `wasm selection: ${created.wasmSelection.selected} (${created.wasmSelection.stage ?? "no stage"})`),
        );
        created.renderer.dispose();
      } catch (e) {
        setPolicyDemo(`createRenderer({ backend: "${backend}" }) → error: ${(e as Error).message}`);
      }
    },
    [],
  );

  const runBenchmarks = useCallback(async (): Promise<void> => {
    setBenchmarkRunning(true);
    setError(null);
    setBenchmarks(null);
    try {
      const rows: BenchmarkRow[] = [];
      for (const backend of ["ts", "wasm", "webgpu"] as const) {
        const row: BenchmarkRow = { backend, smallMs: null, largeMs: null, note: "" };
        for (const [name, cfg] of Object.entries(SCENES)) {
          if (backend === "webgpu") {
            const gpu = gpuNavigator();
            if (gpu === null) {
              row.note = "unavailable: navigator.gpu is missing (no fake timings)";
              continue;
            }
            try {
              let holder = gpuPipelineRef.current;
              if (holder === null) {
                const adapter = await gpu.requestAdapter();
                if (adapter === null) {
                  row.note = "unavailable: no WebGPU adapter (no fake timings)";
                  continue;
                }
                const device = await adapter.requestDevice();
                const canvas = gpuCanvasRef.current;
                if (canvas === null) {
                  row.note = "unavailable: gpu canvas missing";
                  continue;
                }
                canvas.width = 0;
                canvas.height = 0;
                const context = canvas.getContext("webgpu") as unknown as GpuCanvasContextLike;
                const format = gpu.getPreferredCanvasFormat();
                const pipeline = new GpuScenePipeline(
                  device as unknown as GpuPipelineDeviceLike,
                  context,
                  format as never,
                );
                holder = { pipeline, device, context, format };
                gpuPipelineRef.current = holder;
              }
              // Warm with the opposite variant so measured sample 0 also
              // invalidates the full chain (all measured samples are full).
              const scene = makeScene(cfg, 1);
              holder.pipeline.render({
                scene,
                dpr: 1,
                shadowOptions: BENCH_OPTIONS.shadow,
                debugReadback: false,
              });
              const start = performance.now();
              let fullChainSamples = 0;
              for (let i = 0; i < iterations; i++) {
                // ALTERNATE two scenes that invalidate the full chain:
                // retained frames would skip the compute passes and
                // understate GPU time, producing a misleading comparison.
                const stats = holder.pipeline.render({
                  scene: makeScene(cfg, (i % 2) as 0 | 1),
                  dpr: 1,
                  shadowOptions: BENCH_OPTIONS.shadow,
                  debugReadback: false,
                });
                if (stats.invalidation.executed.length === 6) {
                  fullChainSamples += 1;
                }
              }
              const measured = (performance.now() - start) / iterations;
              if (name === "small") {
                row.smallMs = measured;
              } else {
                row.largeMs = measured;
              }
              row.note =
                `host ms · full-chain samples ${fullChainSamples}/${iterations} ` +
                `(alternating scenes; retained frames would understate GPU time)`;
            } catch (e) {
              row.note = `unavailable: ${(e as Error).message}`;
            }
            continue;
          }
          const ms = await timeBackend(backend, cfg, iterations, pipelineRef.current);
          if (ms !== null) {
            if (name === "small") {
              row.smallMs = ms;
            } else {
              row.largeMs = ms;
            }
          }
        }
        rows.push(row);
      }
      setBenchmarks(rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBenchmarkRunning(false);
    }
  }, [iterations]);

  return (
    <main>
      <h1>Ukibori WASM diagnostics — #33 WASM-assisted CPU fallback</h1>
      <p className="note">
        <a href="/renderer-debug.html">renderer debug</a> ·{" "}
        <a href="/scheduler-debug.html">scheduler debug</a>
      </p>
      {error !== null ? (
        <p style={{ color: "#a11" }}>
          Error: {error} · <a href="/renderer-debug.html">renderer debug</a>
        </p>
      ) : (
        <>
          <section>
            <h2>1. Support &amp; selection state</h2>
            <p>
              <span className="badge">WebAssembly supported: {String(typeof WebAssembly !== "undefined")}</span>
              <span className="badge">
                kernel loaded: {selection === null ? "…" : String(selection.loaded)} (v{selection?.kernelVersion ?? "–"})
              </span>
              <span className="badge">
                load: {selection === null ? "–" : `${selection.loadMs.toFixed(2)} ms`}
              </span>
              <span className="badge">
                selected path: {selection === null ? "…" : selection.selected}
              </span>
              <span className="badge">
                actual WASM stage: {selection?.stage ?? "none"}
              </span>
            </p>
            <div className="btn-row">
              {(["auto", "wasm", "cpu"] as const).map((mode) => (
                <button key={mode} type="button" onClick={() => void runSelection(mode)}>
                  selection: {mode}
                  {selectionMode === mode ? " (active)" : ""}
                </button>
              ))}
              <button
                type="button"
                onClick={() => {
                  resetWasmSelectionCache();
                  setLifecycle("selection cache reset — next selection re-probes");
                }}
              >
                Reset selection cache
              </button>
            </div>
            {selection !== null ? (
              <pre className="state">
                {JSON.stringify(
                  {
                    selected: selection.selected,
                    stage: selection.stage,
                    supported: selection.supported,
                    loaded: selection.loaded,
                    kernelVersion: selection.kernelVersion,
                    fallbackReason: selection.fallbackReason,
                    decision: selection.decision,
                    probe: {
                      size: selection.probeSize,
                      iterations: selection.probeIterations,
                      ms: selection.probeMs.toFixed(2),
                      tsMs: selection.tsMs.toFixed(3),
                      wasmMs: selection.wasmMs.toFixed(3),
                      ratio: selection.probeRatio.toFixed(3),
                      parityOk: selection.parityOk,
                      maxNormalError: selection.maxNormalError,
                    },
                  },
                  null,
                  2,
                )}
              </pre>
            ) : null}
            <p className="note">
              Selection rules: WASM is chosen only when the bounded startup probe shows exact
              oracle parity AND a documented benefit (wasm &lt; ts × 0.9). Timing is reported but
              never silently overrides the gates. The decision is cached; the reset button clears
              it (tests provide deterministic force overrides).
            </p>
          </section>

          <section>
            <h2>2. Backend policy demo (createRenderer)</h2>
            <div className="btn-row">
              {(["auto", "webgpu", "wasm", "cpu"] as const).map((backend) => (
                <button key={backend} type="button" onClick={() => void runPolicyDemo(backend)}>
                  backend: {backend}
                </button>
              ))}
            </div>
            {policyDemo !== null ? <p className="note">{policyDemo}</p> : null}
            <p className="note">
              auto starts WebGPU detection FIRST and is never delayed by WASM compilation or
              benchmarking; a winning WebGPU releases the optional WASM kernel off its critical
              path.
            </p>
          </section>

          <section>
            <h2>3. Render path, stage provenance &amp; transfer metrics</h2>
            <div className="btn-row">
              <button type="button" onClick={() => void renderScene(null)}>Render (WASM path)</button>
              <button type="button" onClick={() => void renderScene(500)}>Render + abort after 500 ms</button>
              <button
                type="button"
                onClick={() => setRenderPath((p) => (p === "wasm" ? "ts" : "wasm"))}
              >
                path: {renderPath} ({renderPath === "wasm" ? "WASM-assisted" : "TypeScript oracle"})
              </button>
              <button type="button" onClick={disposePipeline}>Dispose pipeline</button>
              <button type="button" onClick={() => void recreatePipeline()}>Re-create pipeline</button>
            </div>
            <p>
              <span className="badge">lifecycle: {lifecycle}</span>
              {lastRender !== null ? (
                <span className="badge ok">
                  WASM stage: {lastRender.wasmStages.normal === "wasm" ? "normal (wasm)" : "none"}
                </span>
              ) : null}
            </p>
            <div className="row">
              <canvas ref={canvasRef} width={96} height={60} />
              <canvas ref={gpuCanvasRef} width={96} height={60} style={{ display: "none" }} />
            </div>
            {lastRender !== null ? (
              <>
                <p className="note">
                  Stage provenance (which stage ACTUALLY ran in WASM — a TypeScript-only
                  execution is never labeled WASM):{" "}
                  {JSON.stringify(lastRender.wasmStages)}
                </p>
                <table>
                  <thead>
                    <tr>
                      <th>metric</th>
                      <th>value</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>total render (host ms)</td>
                      <td>{lastRender.totalMs.toFixed(3)}</td>
                    </tr>
                    <tr>
                      <td>kernel (host ms)</td>
                      <td>{lastRender.wasmStats.kernelMs.toFixed(3)}</td>
                    </tr>
                    <tr>
                      <td>transfer (host ms)</td>
                      <td>{lastRender.wasmStats.transferMs.toFixed(3)}</td>
                    </tr>
                    <tr>
                      <td>JS→WASM bytes</td>
                      <td>{lastRender.wasmStats.jsToWasmBytes.toLocaleString()}</td>
                    </tr>
                    <tr>
                      <td>WASM→JS bytes</td>
                      <td>{lastRender.wasmStats.wasmToJsBytes.toLocaleString()}</td>
                    </tr>
                    <tr>
                      <td>memory pages / growth count</td>
                      <td>
                        {lastRender.wasmStats.memoryPages} / {lastRender.wasmStats.growthCount}
                      </td>
                    </tr>
                    <tr>
                      <td>kernel ABI version</td>
                      <td>{lastRender.wasmStats.kernelVersion}</td>
                    </tr>
                  </tbody>
                </table>
                {parity !== null ? (
                  <p className="note">
                    Parity vs the TypeScript oracle (byte-exact):{" "}
                    <span className={parity.ok ? "badge ok" : "badge bad"}>
                      {parity.ok ? "PASS" : "FAIL"}
                    </span>{" "}
                    max normal delta {parity.maxNormalDelta} · max color delta {parity.maxColorDelta}
                  </p>
                ) : null}
              </>
            ) : null}
            <p className="note">
              Cancellation is honored at JS stage boundaries: an aborted render rejects with
              AbortError and never publishes a result (the previous frame stays on the canvas).
              Disposal is idempotent and rejects new work until the pipeline is re-created.
            </p>
          </section>

          <section>
            <h2>4. Benchmarks — TS vs WASM vs WebGPU (honest host wall-clock, non-gating)</h2>
            <p className="note">
              Mean host wall-clock ms per render, {iterations} iterations, over a representative
              small (96×60) and large (480×300) scene. WebGPU rows report “unavailable” when no
              adapter exists — never fake timings. No GPU timestamps are fabricated; these rows
              are informational only (parity, lifecycle and selection rules are the gates).
            </p>
            <p className="note">
              iterations:{" "}
              <input
                type="number"
                min={1}
                max={30}
                value={iterations}
                onChange={(e) => setIterations(Math.max(1, Number(e.target.value) || 1))}
                style={{ width: 64 }}
              />
            </p>
            <div className="btn-row">
              <button type="button" onClick={() => void runBenchmarks()} disabled={benchmarkRunning}>
                {benchmarkRunning ? "running…" : "Run benchmarks"}
              </button>
            </div>
            {benchmarks !== null ? (
              <table>
                <thead>
                  <tr>
                    <th>backend</th>
                    <th>small (96×60) ms</th>
                    <th>large (480×300) ms</th>
                    <th>note</th>
                  </tr>
                </thead>
                <tbody>
                  {benchmarks.map((row) => (
                    <tr key={row.backend}>
                      <td>{row.backend}</td>
                      <td>{row.smallMs === null ? "—" : row.smallMs.toFixed(3)}</td>
                      <td>{row.largeMs === null ? "—" : row.largeMs.toFixed(3)}</td>
                      <td style={{ textAlign: "left" }}>{row.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </section>
        </>
      )}
    </main>
  );
}

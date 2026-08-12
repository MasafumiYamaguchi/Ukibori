import { HostBuffer } from "../buffer";
import { computeNormals } from "../lighting";
import type { NormalOptions } from "../lighting";
import { NORMAL_SPEC } from "../types";
import { WasmNormalKernel } from "./kernel";
import type { WasmKernelStats } from "./kernel";

/**
 * #33 WASM backend selection.
 *
 * Selection rules (deterministic; timing is never the gate by itself):
 *
 *   1. WebAssembly must be supported and the module must load.
 *   2. A BOUNDED startup probe runs the representative workload (normal
 *      generation on a fixed synthetic height field) through BOTH the
 *      TypeScript oracle and the WASM kernel. Probe parity is REQUIRED:
 *      any normal component mismatch disqualifies WASM (never run a wrong
 *      kernel silently). The probe is bounded by a wall-clock budget and
 *      fixed iterations.
 *   3. WASM is selected only when the probe demonstrates a documented
 *      benefit: `wasmMs < tsMs * (1 - BENEFIT_MARGIN)` (>= 10% faster).
 *   4. `force` is the deterministic override for tests and callers:
 *      `"wasm"` keeps parity as the ONLY gate (timing skipped), `"cpu"`
 *      skips the whole path. Never a silent behavioral override — the
 *      decision is always reported with its fallback reason.
 *   5. The decision (including timing evidence) is CACHED per module
 *      identity; `resetWasmSelectionCache()` clears it for tests.
 *
 * WebGPU interplay: selection here NEVER starts before WebGPU detection and
 * is never awaited by it — `createRenderer({ backend: "auto" })` starts
 * `createWebGpuBackend()` first (see renderer.ts).
 */

export const WASM_BENEFIT_MARGIN = 0.1;
export const DEFAULT_PROBE_WIDTH = 192;
export const DEFAULT_PROBE_HEIGHT = 128;
export const DEFAULT_PROBE_ITERATIONS = 3;
export const DEFAULT_PROBE_BUDGET_MS = 1500;

export interface WasmSelectionOptions {
  /** Deterministic override: "wasm" (timing skipped, parity still gating),
   * "cpu" (skip WASM entirely), "auto" (default rules). */
  force?: "wasm" | "cpu" | "auto";
  /** Custom module bytes (test/advanced seam; defaults to the checked-in
   * deterministic module). Must export the kernel ABI. */
  moduleBytes?: Uint8Array;
  /** Probe field dimensions (default 192x128). */
  probeSize?: { width: number; height: number };
  /** Probe iterations (default 3). */
  probeIterations?: number;
  /** Wall-clock budget for the whole probe (default 1500 ms). */
  probeBudgetMs?: number;
  /** Skip the timing-benefit gate and accept parity alone. */
  requireBenefit?: boolean;
}

export interface WasmSelectionReport {
  /** The selection outcome: "wasm" or "cpu" (TypeScript fallback). */
  selected: "wasm" | "cpu";
  /** Which pipeline stage actually runs in WASM ("normal") or none. */
  stage: "normal" | null;
  /** The loaded kernel when available (null on early fallback paths). */
  kernel: WasmNormalKernel | null;
  /** WebAssembly support + module load succeeded. */
  supported: boolean;
  /** Kernel loaded successfully. */
  loaded: boolean;
  /** Kernel ABI version (1) when loaded, else null. */
  kernelVersion: number | null;
  /** Wall-clock module load time, ms. */
  loadMs: number;
  /** Wall-clock probe time, ms. */
  probeMs: number;
  probeIterations: number;
  probeSize: { width: number; height: number };
  /** Oracle mean wall-clock per iteration, ms. */
  tsMs: number;
  /** WASM mean wall-clock per iteration, ms. */
  wasmMs: number;
  /** wasm/ts mean ratio (lower is better). */
  probeRatio: number;
  /** Exact bit parity of the probe output vs the oracle. */
  parityOk: boolean;
  /** Measured max normal component delta in the probe. */
  maxNormalError: number;
  /** Machine-readable fallback reason ("wasm" selection -> null). */
  fallbackReason: string | null;
  /** Human-readable decision. */
  decision: string;
  /** Probe kernel stats snapshot (transfer sizes, memory, growth). */
  kernelStats: WasmKernelStats | null;
}

/** Deterministic synthetic probe field (f32 values, no RNG). */
function probeField(width: number, height: number): Float32Array {
  const field = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v =
        0.5 +
        0.25 * Math.sin(x * 0.35) +
        0.2 * Math.cos(y * 0.5) +
        0.05 * Math.sin((x + y) * 0.9) +
        (x % 7 === 0 ? 1 : 0);
      field[y * width + x] = Math.fround(v);
    }
  }
  return field;
}

/** The probe's normal options (DPR-1 defaults). */
const PROBE_NORMAL_OPTIONS: NormalOptions = { scaleX: 0.5, scaleY: 0.5, normalScale: 1 };

/** TS oracle timing for the probe workload. */
function oracleProbeMs(field: Float32Array, width: number, height: number, iterations: number): number {
  const heightBuf = new HostBuffer({ width, height, channels: 1, format: "f32" });
  heightBuf.data.set(field);
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    computeNormals(heightBuf, PROBE_NORMAL_OPTIONS);
  }
  return (performance.now() - start) / iterations;
}

function exactParity(wasm: Float32Array, oracle: Float32Array): { ok: boolean; maxError: number } {
  let maxError = 0;
  for (let i = 0; i < wasm.length; i++) {
    const a = wasm[i];
    const b = oracle[i];
    const delta = Math.abs(a - b);
    if (delta > maxError) {
      maxError = delta;
    }
    if (!Object.is(a, b)) {
      return { ok: false, maxError };
    }
  }
  return { ok: true, maxError };
}

/** The TS oracle's normal field for the probe field (comparison reference). */
function oracleNormals(field: Float32Array, width: number, height: number): Float32Array {
  const heightBuf = new HostBuffer({ width, height, channels: 1, format: "f32" });
  heightBuf.data.set(field);
  const normal = computeNormals(heightBuf, PROBE_NORMAL_OPTIONS);
  const out = new Float32Array(width * height * 3);
  const spec = NORMAL_SPEC(width, height);
  void spec;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3;
      out[o] = normal.get(x, y, 0);
      out[o + 1] = normal.get(x, y, 1);
      out[o + 2] = normal.get(x, y, 2);
    }
  }
  return out;
}

// Cached decision per module identity (the checked-in module by default).
const selectionCache = new Map<string, Promise<WasmSelectionReport>>();

export function resetWasmSelectionCache(): void {
  selectionCache.clear();
}

function hasWebAssembly(): boolean {
  return (
    typeof WebAssembly !== "undefined" &&
    typeof WebAssembly.compile === "function" &&
    typeof WebAssembly.instantiate === "function"
  );
}

/** Run the bounded probe; returns timing + parity evidence. */
async function runProbe(
  kernel: WasmNormalKernel,
  options: WasmSelectionOptions,
): Promise<{
  probeMs: number;
  tsMs: number;
  wasmMs: number;
  probeRatio: number;
  parityOk: boolean;
  maxNormalError: number;
  kernelStats: WasmKernelStats | null;
  probeIterations: number;
  probeSize: { width: number; height: number };
}> {
  const width = options.probeSize?.width ?? DEFAULT_PROBE_WIDTH;
  const height = options.probeSize?.height ?? DEFAULT_PROBE_HEIGHT;
  const iterations = options.probeIterations ?? DEFAULT_PROBE_ITERATIONS;
  const budgetMs = options.probeBudgetMs ?? DEFAULT_PROBE_BUDGET_MS;
  const started = performance.now();

  const field = probeField(width, height);
  const oracle = oracleNormals(field, width, height);

  // parity first (one warmup + one measured pass)
  const parity = await kernel.computeNormals(field, width, height, PROBE_NORMAL_OPTIONS);
  const parityResult = exactParity(parity.normal, oracle);

  const tsStart = performance.now();
  const tsMs = oracleProbeMs(field, width, height, iterations);
  const oracleWall = performance.now() - tsStart;

  const wasmStart = performance.now();
  let wasmStats: WasmKernelStats | null = null;
  for (let i = 0; i < iterations; i++) {
    const result = await kernel.computeNormals(field, width, height, PROBE_NORMAL_OPTIONS);
    wasmStats = result.stats;
  }
  const wasmMs = (performance.now() - wasmStart) / iterations;
  const probeMs = performance.now() - started;
  void oracleWall;

  if (probeMs > budgetMs) {
    throw new Error(`probe exceeded the ${budgetMs} ms budget (${probeMs.toFixed(1)} ms)`);
  }

  return {
    probeMs,
    tsMs,
    wasmMs,
    probeRatio: tsMs > 0 ? wasmMs / tsMs : 0,
    parityOk: parityResult.ok,
    maxNormalError: parityResult.maxError,
    kernelStats: wasmStats,
    probeIterations: iterations,
    probeSize: { width, height },
  };
}

/**
 * Select the CPU fallback path: WASM-assisted or plain TypeScript.
 *
 * `cacheKey` is the shared-load cache identity (default: the checked-in
 * module). The decision is cached; clear with `resetWasmSelectionCache()`.
 */
export async function selectWasmBackend(
  options: WasmSelectionOptions = {},
  cacheKey: string = "ukibori-normal-kernel-v1",
): Promise<WasmSelectionReport> {
  const force = options.force ?? "auto";
  if (force === "cpu" || !hasWebAssembly()) {
    return {
      selected: "cpu",
      stage: null,
      kernel: null,
      supported: hasWebAssembly(),
      loaded: false,
      kernelVersion: null,
      loadMs: 0,
      probeMs: 0,
      probeIterations: 0,
      probeSize: { width: 0, height: 0 },
      tsMs: 0,
      wasmMs: 0,
      probeRatio: 0,
      parityOk: false,
      maxNormalError: 0,
      fallbackReason: force === "cpu" ? "forced-cpu" : "webassembly-unsupported",
      decision:
        force === "cpu"
          ? "WASM backend explicitly disabled (force: cpu)"
          : "WebAssembly is not supported in this environment",
      kernelStats: null,
    };
  }

  const cached = selectionCache.get(cacheKey);
  if (cached !== undefined) {
    const report = await cached;
    // A cached decision whose kernel was released (backend/pipeline
    // disposal) is stale: re-select instead of handing out a disposed
    // kernel. Never labels a TypeScript-only execution as WASM.
    if (report.kernel === null || !report.kernel.isDisposed) {
      return report;
    }
    selectionCache.delete(cacheKey);
  }
  const run = (async (): Promise<WasmSelectionReport> => {
    const loadStart = performance.now();
    let kernel: WasmNormalKernel;
    try {
      kernel = await WasmNormalKernel.load(
        options.moduleBytes !== undefined ? { bytes: options.moduleBytes, cacheKey } : { cacheKey },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        selected: "cpu",
        stage: null,
        kernel: null,
        supported: true,
        loaded: false,
        kernelVersion: null,
        loadMs: performance.now() - loadStart,
        probeMs: 0,
        probeIterations: 0,
        probeSize: { width: 0, height: 0 },
        tsMs: 0,
        wasmMs: 0,
        probeRatio: 0,
        parityOk: false,
        maxNormalError: 0,
        fallbackReason: `module-load-failed (${message})`,
        decision: `WASM module failed to load; using the TypeScript oracle ("${message}")`,
        kernelStats: null,
      };
    }
    const loadMs = performance.now() - loadStart;

    let evidence;
    try {
      evidence = await runProbe(kernel, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        selected: "cpu",
        stage: null,
        kernel,
        supported: true,
        loaded: true,
        kernelVersion: kernel.kernelVersion,
        loadMs,
        probeMs: 0,
        probeIterations: 0,
        probeSize: { width: options.probeSize?.width ?? DEFAULT_PROBE_WIDTH, height: options.probeSize?.height ?? DEFAULT_PROBE_HEIGHT },
        tsMs: 0,
        wasmMs: 0,
        probeRatio: 0,
        parityOk: false,
        maxNormalError: 0,
        fallbackReason: `probe-failed (${message})`,
        decision: `WASM probe failed; using the TypeScript oracle ("${message}")`,
        kernelStats: null,
      };
    }

    if (!evidence.parityOk) {
      return {
        selected: "cpu",
        stage: null,
        kernel,
        supported: true,
        loaded: true,
        kernelVersion: kernel.kernelVersion,
        loadMs,
        ...evidence,
        fallbackReason: `probe-parity-mismatch (max error ${evidence.maxNormalError.toExponential(2)})`,
        decision: "WASM probe output diverged from the TypeScript oracle; using the oracle",
      };
    }

    const requireBenefit = options.requireBenefit ?? force !== "wasm";
    if (requireBenefit && !(evidence.wasmMs < evidence.tsMs * (1 - WASM_BENEFIT_MARGIN))) {
      return {
        selected: "cpu",
        stage: null,
        kernel,
        supported: true,
        loaded: true,
        kernelVersion: kernel.kernelVersion,
        loadMs,
        ...evidence,
        fallbackReason: `no-measured-benefit (wasm ${evidence.wasmMs.toFixed(3)} ms vs ts ${evidence.tsMs.toFixed(3)} ms)`,
        decision:
          `WASM probe showed no documented benefit (ratio ${evidence.probeRatio.toFixed(3)}); ` +
          `using the TypeScript oracle`,
      };
    }

    return {
      selected: "wasm",
      stage: "normal",
      kernel,
      supported: true,
      loaded: true,
      kernelVersion: kernel.kernelVersion,
      loadMs,
      ...evidence,
      fallbackReason: null,
      decision:
        `WASM normal kernel selected (probe ratio ${evidence.probeRatio.toFixed(3)}, ` +
        `exact oracle parity, ${evidence.wasmMs.toFixed(3)} ms vs ${evidence.tsMs.toFixed(3)} ms per iteration)`,
    };
  })();
  selectionCache.set(cacheKey, run);
  run.catch(() => {
    selectionCache.delete(cacheKey);
  });
  return run;
}

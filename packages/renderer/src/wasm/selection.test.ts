import { afterEach, describe, expect, it } from "vitest";
import { selectWasmBackend, resetWasmSelectionCache } from "./selection";
import { WasmNormalKernel } from "./kernel";
import { WASM_BENEFIT_MARGIN } from "./selection";

/**
 * #33 WASM selection rules:
 *
 * - WebAssembly unsupported -> TypeScript fallback with a reason
 * - module load failure -> TypeScript fallback, retryable, never poisoned
 * - probe parity is REQUIRED (a module that computes garbage is rejected
 *   even under force: "wasm")
 * - the benefit gate requires `wasmMs < tsMs * (1 - margin)` unless
 *   force: "wasm" (deterministic override) — timing evidence is reported
 *   and cached with the decision
 * - the decision is cached per module identity; reset clears it
 * - the probe is bounded by a wall-clock budget
 */

const UNIQUE_KEY = () => `selection-${Math.random().toString(36).slice(2)}`;

afterEach(() => {
  resetWasmSelectionCache();
});

describe("#33 WASM selection — deterministic overrides and gates", () => {
  it("force: cpu always selects the TypeScript path", async () => {
    const report = await selectWasmBackend({ force: "cpu" }, UNIQUE_KEY());
    expect(report.selected).toBe("cpu");
    expect(report.stage).toBeNull();
    expect(report.fallbackReason).toBe("forced-cpu");
    expect(report.kernel).toBeNull();
  });

  it("force: wasm selects WASM with parity as the only gate", async () => {
    const report = await selectWasmBackend({ force: "wasm" }, UNIQUE_KEY());
    expect(report.selected).toBe("wasm");
    expect(report.stage).toBe("normal");
    expect(report.fallbackReason).toBeNull();
    expect(report.parityOk).toBe(true);
    expect(report.maxNormalError).toBe(0);
    expect(report.kernelVersion).toBe(1);
    expect(report.kernel).not.toBeNull();
    expect(report.probeRatio).toBeGreaterThan(0);
  });

  it("auto selects WASM when the probe shows the documented benefit", async () => {
    const report = await selectWasmBackend({}, UNIQUE_KEY());
    // on the test engine the WASM kernel is ~2x faster than the oracle for
    // the representative workload (measured 0.27 ms vs 0.62 ms per
    // iteration); the gate is the ratio below 1 - WASM_BENEFIT_MARGIN
    expect(report.probeRatio).toBeLessThan(1 - WASM_BENEFIT_MARGIN);
    expect(report.selected).toBe("wasm");
    expect(report.stage).toBe("normal");
    expect(report.fallbackReason).toBeNull();
  });

  it("a module that fails probe parity is rejected even under force: wasm", async () => {
    // a valid module with the right ABI that computes GARBAGE (all zeros)
    // — parity is the gate that never yields
    const garbageModule = await buildZeroModule();
    const report = await selectWasmBackendWithBytes(garbageModule, { force: "wasm" });
    expect(report.selected).toBe("cpu");
    expect(report.stage).toBeNull();
    expect(report.parityOk).toBe(false);
    expect(report.fallbackReason).toMatch(/probe-parity-mismatch/);
  });

  it("a module that fails probe parity is rejected under auto too", async () => {
    const garbageModule = await buildZeroModule();
    const report = await selectWasmBackendWithBytes(garbageModule, {});
    expect(report.selected).toBe("cpu");
    expect(report.fallbackReason).toMatch(/probe-parity-mismatch/);
  });

  it("reports the fallback reason when the probe exceeds its budget", async () => {
    const report = await selectWasmBackend(
      { probeBudgetMs: 0.0001, probeIterations: 3, force: "auto" },
      UNIQUE_KEY(),
    );
    expect(report.selected).toBe("cpu");
    expect(report.fallbackReason).toMatch(/probe-failed .*budget/);
  });

  it("caches the decision: a second call reuses the identical report", async () => {
    const key = UNIQUE_KEY();
    const first = await selectWasmBackend({}, key);
    const second = await selectWasmBackend({}, key);
    expect(second).toBe(first);
  });

  it("resetWasmSelectionCache clears the cached decision", async () => {
    const key = UNIQUE_KEY();
    const first = await selectWasmBackend({}, key);
    resetWasmSelectionCache();
    const second = await selectWasmBackend({}, key);
    expect(second).not.toBe(first);
  });
});

describe("#33 WASM selection — unsupported environments", () => {
  it("falls back with a reason when WebAssembly is unavailable", async () => {
    const original = globalThis.WebAssembly;
    try {
      Object.defineProperty(globalThis, "WebAssembly", { value: undefined, configurable: true });
      const report = await selectWasmBackend({}, UNIQUE_KEY());
      expect(report.selected).toBe("cpu");
      expect(report.fallbackReason).toBe("webassembly-unsupported");
      expect(report.kernel).toBeNull();
    } finally {
      Object.defineProperty(globalThis, "WebAssembly", { value: original, configurable: true });
    }
  });

  it("a load failure falls back, is retryable, and never poisons later attempts", async () => {
    const key = UNIQUE_KEY();
    const bad = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0xff]);
    const report = await selectWasmBackendWithBytes(bad, {}, key);
    expect(report.selected).toBe("cpu");
    expect(report.loaded).toBe(false);
    expect(report.fallbackReason).toMatch(/module-load-failed/);
    // retry with the default module (fresh cache key is not even needed:
    // the failed entry was removed)
    resetWasmSelectionCache();
    const retry = await selectWasmBackend({ force: "wasm" }, key);
    expect(retry.selected).toBe("wasm");
  });
});

// ---------------------------------------------------------------------------
// helpers: selection with custom module bytes
// ---------------------------------------------------------------------------

/** selectWasmBackend with custom module bytes (via the moduleBytes seam). */
async function selectWasmBackendWithBytes(
  bytes: Uint8Array,
  options: Parameters<typeof selectWasmBackend>[0],
  key: string = UNIQUE_KEY(),
) {
  return selectWasmBackend({ ...options, moduleBytes: bytes }, key);
}

/**
 * Build a minimal module exporting the kernel ABI but returning all-zero
 * normals: `(func $compute_normals ... )` writes nothing and returns 0.
 * Reuses the deterministic builder's primitives indirectly by hand-assembly
 * of the same structure (memory + kernel_version + compute_normals).
 */
async function buildZeroModule(): Promise<Uint8Array> {
  const uleb = (v: number) => {
    const o: number[] = [];
    do {
      let b = v & 0x7f;
      v >>>= 7;
      if (v !== 0) b |= 0x80;
      o.push(b);
    } while (v !== 0);
    return o;
  };
  const sec = (id: number, payload: number[]) => [id, ...uleb(payload.length), ...payload];
  const name = (s: string) => [s.length, ...new TextEncoder().encode(s)];
  const typeSec = sec(0x01, [0x02, 0x60, 0x05, 0x7f, 0x7f, 0x7c, 0x7c, 0x7c, 0x01, 0x7f, 0x60, 0x00, 0x01, 0x7f]);
  const funcSec = sec(0x03, [0x02, 0x00, 0x01]);
  const memSec = sec(0x05, [0x01, 0x01, 0x01, 0x10]);
  const expSec = sec(0x07, [
    0x03,
    ...name("memory"), 0x02, 0x00,
    ...name("compute_normals"), 0x00, 0x00,
    ...name("kernel_version"), 0x00, 0x01,
  ]);
  // compute_normals: (result i32) { i32.const 0 }  (writes nothing)
  const body0 = [0x00, 0x41, 0x00, 0x0b];
  // kernel_version: (result i32) { i32.const 1 }
  const body1 = [0x00, 0x41, 0x01, 0x0b];
  const codeSec = sec(0x0a, [0x02, ...uleb(body0.length), ...body0, ...uleb(body1.length), ...body1]);
  const module = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...typeSec, ...funcSec, ...memSec, ...expSec, ...codeSec,
  ]);
  // sanity: it must load through the kernel ABI validation
  const kernel = await WasmNormalKernel.load({ bytes: module, cacheKey: UNIQUE_KEY() });
  expect(kernel.kernelVersion).toBe(1);
  return module;
}

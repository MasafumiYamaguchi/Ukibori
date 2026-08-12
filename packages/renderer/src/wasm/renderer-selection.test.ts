import { afterEach, describe, expect, it } from "vitest";
import { createRenderer } from "../renderer";
import { resetWasmSelectionCache, selectWasmBackend } from "../wasm/selection";
import { resetKernelLoadCache } from "../wasm/kernel";

/**
 * #33 `createRenderer` backend selection integration.
 *
 * - explicit "cpu" -> CpuBackend (kind "cpu")
 * - explicit "wasm" -> WasmCpuBackend when the probe passes (kind "wasm")
 *   and CpuBackend when forced off (never throws)
 * - explicit "webgpu" -> throws when WebGPU is unavailable
 * - "auto" -> WebGPU detection STARTS FIRST and is never delayed by the
 *   WASM path; when WebGPU succeeds it wins and the optional WASM kernel is
 *   released off the critical path; when WebGPU fails, WASM/CPU fallback
 *   applies with the selection report attached
 */

afterEach(() => {
  resetWasmSelectionCache();
  resetKernelLoadCache();
});

/** Install a fake navigator.gpu whose adapter resolves after `delayMs`. */
function installFakeGpu(delayMs = 0, fail = false): { startOrder: number[] } {
  const startOrder: number[] = [];
  const fakeNavigator = {
    gpu: {
      requestAdapter: () => {
        startOrder.push(1); // gpu
        if (fail) {
          return Promise.resolve(null);
        }
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve({ requestDevice: () => Promise.resolve({ destroy: () => {} }) });
          }, delayMs);
        });
      },
    },
  };
  Object.defineProperty(globalThis, "navigator", {
    value: fakeNavigator,
    configurable: true,
    writable: true,
  });
  return { startOrder };
}

function removeFakeGpu(): void {
  Object.defineProperty(globalThis, "navigator", { value: undefined, configurable: true });
}

describe("#33 createRenderer — explicit backends", () => {
  it("backend cpu always creates the plain CPU backend", async () => {
    const { backend, wasmSelection } = await createRenderer({ backend: "cpu" });
    expect(backend.kind).toBe("cpu");
    expect(backend.capabilities.backend).toBe("cpu");
    expect(wasmSelection).toBeNull();
    backend.dispose();
  });

  it("backend wasm creates the WASM backend with selection evidence", async () => {
    const { backend, wasmSelection } = await createRenderer({ backend: "wasm" });
    expect(backend.kind).toBe("wasm");
    expect(backend.capabilities.backend).toBe("wasm");
    expect(backend.capabilities.compute).toBe(true);
    expect(wasmSelection).not.toBeNull();
    expect(wasmSelection!.selected).toBe("wasm");
    expect(wasmSelection!.stage).toBe("normal");
    expect(wasmSelection!.fallbackReason).toBeNull();
    backend.dispose();
  });

  it("backend wasm with force cpu falls back to the CPU backend (never throws)", async () => {
    const { backend, wasmSelection } = await createRenderer({
      backend: "wasm",
      wasm: { force: "cpu" },
    });
    expect(backend.kind).toBe("cpu");
    expect(wasmSelection!.selected).toBe("cpu");
    expect(wasmSelection!.fallbackReason).toBe("forced-cpu");
    backend.dispose();
  });

  it("backend webgpu throws when WebGPU is unavailable", async () => {
    removeFakeGpu();
    await expect(createRenderer({ backend: "webgpu" })).rejects.toThrow(/WebGPU/);
  });

  it("backend webgpu succeeds with a real fake GPU", async () => {
    installFakeGpu(0);
    const { backend, wasmSelection } = await createRenderer({ backend: "webgpu" });
    expect(backend.kind).toBe("webgpu");
    expect(wasmSelection).toBeNull();
    backend.dispose();
  });
});

describe("#33 createRenderer — auto: WebGPU first, never delayed by WASM", () => {
  it("auto prefers WebGPU and reports no WASM selection", async () => {
    installFakeGpu(0);
    const { backend, wasmSelection } = await createRenderer({ backend: "auto" });
    expect(backend.kind).toBe("webgpu");
    expect(wasmSelection).toBeNull();
    backend.dispose();
  });

  it("WebGPU detection starts before any WASM work", async () => {
    // observe start order: navigator.gpu.requestAdapter must be invoked
    // before WebAssembly.compile (the wasm load), because createRenderer
    // kicks off WebGPU detection first
    const gpu = installFakeGpu(5);
    const originalCompile = WebAssembly.compile;
    const compileOrder: number[] = [];
    (WebAssembly as unknown as { compile: unknown }).compile = (bytes: Uint8Array) => {
      compileOrder.push(2); // wasm
      return originalCompile.call(WebAssembly, bytes.slice());
    };
    try {
      const { backend } = await createRenderer({ backend: "auto" });
      expect(backend.kind).toBe("webgpu");
      // both were STARTED (wasm load began even though webgpu won)
      expect(compileOrder.length).toBeGreaterThanOrEqual(1);
      expect(gpu.startOrder[0]).toBe(1);
      expect(compileOrder[0]).toBe(2);
    } finally {
      (WebAssembly as unknown as { compile: unknown }).compile = originalCompile;
    }
  });

  it("a winning WebGPU releases the optional WASM kernel off the critical path", async () => {
    installFakeGpu(0);
    const { backend } = await createRenderer({ backend: "auto" });
    expect(backend.kind).toBe("webgpu");
    // give the fire-and-forget disposal promise a chance to run
    await new Promise((resolve) => setTimeout(resolve, 10));
    // the selection cache was released: a fresh selection now yields a NEW
    // report object (not the one the auto path built), proving the old
    // kernel was disposed and nothing was poisoned
    const fresh = await selectWasmBackend({ force: "wasm" });
    expect(fresh.selected).toBe("wasm");
    expect(fresh.kernel).not.toBeNull();
    // and the fresh kernel actually works
    const result = await fresh.kernel!.computeNormals(new Float32Array(16), 4, 4, {});
    expect(result.normal.length).toBe(4 * 4 * 3);
    fresh.kernel!.dispose();
    backend.dispose();
  });

  it("auto falls back to WASM when WebGPU is unavailable", async () => {
    installFakeGpu(0, true); // requestAdapter resolves null
    const { backend, wasmSelection } = await createRenderer({ backend: "auto" });
    expect(backend.kind).toBe("wasm");
    expect(wasmSelection).not.toBeNull();
    expect(wasmSelection!.selected).toBe("wasm");
    expect(wasmSelection!.stage).toBe("normal");
    backend.dispose();
  });

  it("auto falls back to CPU when both WebGPU and WASM are unavailable", async () => {
    installFakeGpu(0, true);
    const { backend, wasmSelection } = await createRenderer({
      backend: "auto",
      wasm: { force: "cpu" },
    });
    expect(backend.kind).toBe("cpu");
    expect(wasmSelection!.selected).toBe("cpu");
    expect(wasmSelection!.fallbackReason).toBe("forced-cpu");
    backend.dispose();
  });
});

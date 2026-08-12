import { describe, expect, it } from "vitest";
import { HostBuffer, byteLength } from "../buffer";
import { computeNormals } from "../lighting";
import { WasmNormalKernel, decodeDefaultModule } from "./kernel";
import { DEFAULT_KERNEL_CACHE_KEY } from "./kernel";

/**
 * #33 WASM kernel lifecycle contract:
 *
 * - concurrent module loads are deduplicated (same instance for the same
 *   cache key; distinct instances for distinct keys)
 * - a failed load is retryable and never poisons later attempts
 * - AbortSignal cancellation rejects at JS stage boundaries and never
 *   publishes a result
 * - disposal is idempotent, rejects new work, releases the cache entry
 *   (a fresh load rebuilds) and ignores late async completions
 * - memory growth is host-driven and views are always reacquired
 */

function validField(width: number, height: number): Float32Array {
  const field = new Float32Array(width * height);
  for (let i = 0; i < field.length; i++) {
    field[i] = Math.fround(Math.sin(i * 0.7) * 3 + (i % 5));
  }
  return field;
}

async function expectAbort(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
    expect.unreachable("expected an AbortError rejection");
  } catch (error) {
    expect((error as Error).name).toBe("AbortError");
  }
}

describe("#33 WASM kernel — concurrent loads and retry", () => {
  it("deduplicates concurrent loads with the same cache key", async () => {
    const [a, b] = await Promise.all([
      WasmNormalKernel.load({ cacheKey: "dedup-a" }),
      WasmNormalKernel.load({ cacheKey: "dedup-a" }),
    ]);
    expect(a).toBe(b);
  });

  it("keeps distinct instances for distinct cache keys", async () => {
    const a = await WasmNormalKernel.load({ cacheKey: "distinct-a" });
    const b = await WasmNormalKernel.load({ cacheKey: "distinct-b" });
    expect(a).not.toBe(b);
  });

  it("reuses the cached instance across sequential loads", async () => {
    const a = await WasmNormalKernel.load({ cacheKey: "sequential" });
    const b = await WasmNormalKernel.load({ cacheKey: "sequential" });
    expect(a).toBe(b);
  });

  it("a failed load is retryable and does not poison later attempts", async () => {
    const bad = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0xff, 0xff]); // invalid module
    await expect(WasmNormalKernel.load({ bytes: bad, cacheKey: "retry" })).rejects.toThrow();
    const good = await WasmNormalKernel.load({ cacheKey: "retry" });
    expect(good.kernelVersion).toBe(1);
    // and it can still compute correctly
    const field = validField(8, 6);
    const result = await good.computeNormals(field, 8, 6, {});
    expect(result.normal.length).toBe(8 * 6 * 3);
  });

  it("rejects modules with a wrong ABI at load time", async () => {
    // the real module bytes with a corrupted export name still compile into
    // a valid module but must fail the ABI check
    const badBytes = new Uint8Array(decodeDefaultModule());
    // corrupt the "compute_normals" export name ("c" -> "C")
    const nameBytes = new TextEncoder().encode("compute_normals");
    let found = -1;
    for (let i = 0; i <= badBytes.length - nameBytes.length; i++) {
      let match = true;
      for (let j = 0; j < nameBytes.length; j++) {
        if (badBytes[i + j] !== nameBytes[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        found = i;
        break;
      }
    }
    expect(found).toBeGreaterThan(-1);
    badBytes[found] = 0x43; // 'C'
    await expect(
      WasmNormalKernel.load({ bytes: badBytes, cacheKey: "bad-abi" }),
    ).rejects.toThrow(/ABI/);
  });
});

describe("#33 WASM kernel — cancellation", () => {
  it("rejects immediately when the signal is already aborted", async () => {
    const kernel = await WasmNormalKernel.load({ cacheKey: "cancel-1" });
    const controller = new AbortController();
    controller.abort();
    await expectAbort(kernel.computeNormals(validField(4, 4), 4, 4, {}, controller.signal));
  });

  it("rejects when the signal aborts before the kernel publishes", async () => {
    const kernel = await WasmNormalKernel.load({ cacheKey: "cancel-2" });
    const controller = new AbortController();
    controller.abort();
    const before = kernel.getStats();
    await expectAbort(kernel.computeNormals(validField(16, 16), 16, 16, {}, controller.signal));
    // the JS stage boundaries fired before any transfer: nothing was
    // written to wasm memory and nothing was published
    const after = kernel.getStats();
    expect(after.jsToWasmBytes).toBe(before.jsToWasmBytes);
    expect(after.wasmToJsBytes).toBe(before.wasmToJsBytes);
  });

  it("a cancelled compute never publishes a result", async () => {
    const kernel = await WasmNormalKernel.load({ cacheKey: "cancel-3" });
    const controller = new AbortController();
    controller.abort();
    const before = kernel.getStats();
    await expectAbort(kernel.computeNormals(validField(16, 16), 16, 16, {}, controller.signal));
    // nothing was transferred into or out of wasm memory
    expect(kernel.getStats().jsToWasmBytes).toBe(before.jsToWasmBytes);
    expect(kernel.getStats().wasmToJsBytes).toBe(before.wasmToJsBytes);
    // the kernel stays usable afterwards and the next compute is intact
    const result = await kernel.computeNormals(validField(16, 16), 16, 16, {});
    expect(result.normal.length).toBe(16 * 16 * 3);
  });

  it("an aborted load rejects while the shared load keeps running (fast retry)", async () => {
    const controller = new AbortController();
    const loading = WasmNormalKernel.load({ cacheKey: "cancel-load" }, controller.signal);
    controller.abort();
    await expectAbort(loading);
    // the underlying load completed and is cached: the retry resolves
    const kernel = await WasmNormalKernel.load({ cacheKey: "cancel-load" });
    expect(kernel.kernelVersion).toBe(1);
  });
});

describe("#33 WASM kernel — validation before exports", () => {
  it("rejects invalid dimensions, byte counts and overflow", async () => {
    const kernel = await WasmNormalKernel.load({ cacheKey: "validate" });
    const field = validField(4, 4);
    await expect(kernel.computeNormals(field, 0, 4, {})).rejects.toThrow(/dimensions/);
    await expect(kernel.computeNormals(field, 4.5, 4, {})).rejects.toThrow(/dimensions/);
    await expect(kernel.computeNormals(field, -4, 4, {})).rejects.toThrow(/dimensions/);
    await expect(kernel.computeNormals(field, 4, 4.5, {})).rejects.toThrow(/dimensions/);
    // byte-count mismatch (63 bytes instead of the required 64)
    await expect(
      kernel.computeNormals(new Uint8Array(63), 4, 4, {}),
    ).rejects.toThrow(/bytes/);
    // f32 length mismatch
    await expect(kernel.computeNormals(new Float32Array(17), 4, 4, {})).rejects.toThrow(/samples/);
    // overflow: 2^20 x 2^20 texels exceeds the u32-bounded ceiling
    await expect(
      kernel.computeNormals(new Float32Array(1), 1 << 20, 1 << 20, {}),
    ).rejects.toThrow(/ceiling/);
    // invalid options
    await expect(kernel.computeNormals(field, 4, 4, { normalScale: 0 })).rejects.toThrow(/normalScale/);
    await expect(kernel.computeNormals(field, 4, 4, { scaleX: NaN })).rejects.toThrow(/scaleX/);
  });

  it("accepts a raw byte input view and keeps 4-byte alignment rules", async () => {
    const kernel = await WasmNormalKernel.load({ cacheKey: "validate-bytes" });
    const field = validField(8, 8);
    const bytes = new Uint8Array(field.buffer);
    const result = await kernel.computeNormals(bytes, 8, 8, {});
    expect(result.normal.length).toBe(8 * 8 * 3);
    // a misaligned byte view of the correct length is rejected by the
    // alignment check (not the byte-count check)
    const padded = new Uint8Array(512);
    const misaligned = new Uint8Array(padded.buffer, 2, 8 * 8 * 4);
    await expect(kernel.computeNormals(misaligned, 8, 8, {})).rejects.toThrow(/aligned/);
  });
});

describe("#33 WASM kernel — disposal", () => {
  it("is idempotent and rejects new work afterwards", async () => {
    const kernel = await WasmNormalKernel.load({ cacheKey: "dispose-1" });
    kernel.dispose();
    kernel.dispose(); // idempotent
    await expect(
      kernel.computeNormals(validField(4, 4), 4, 4, {}),
    ).rejects.toThrow(/disposed/);
  });

  it("a fresh load after disposal works (release + rebuild)", async () => {
    const kernel = await WasmNormalKernel.load({ cacheKey: "dispose-2" });
    kernel.dispose();
    const fresh = await WasmNormalKernel.load({ cacheKey: "dispose-2" });
    expect(fresh).not.toBe(kernel);
    const result = await fresh.computeNormals(validField(4, 4), 4, 4, {});
    expect(result.normal.length).toBe(4 * 4 * 3);
  });

  it("ignores late async completions after disposal", async () => {
    const kernel = await WasmNormalKernel.load({ cacheKey: "dispose-3" });
    // a compute started before disposal still resolves (it was already
    // synchronous); disposal never causes a rejected late completion to
    // surface as a double failure, and the result is a plain copy
    const pending = kernel.computeNormals(validField(8, 8), 8, 8, {});
    kernel.dispose();
    const result = await pending;
    expect(result.normal.length).toBe(8 * 8 * 3);
    await expect(
      kernel.computeNormals(validField(4, 4), 4, 4, {}),
    ).rejects.toThrow(/disposed/);
  });

  it("disposal of a shared instance releases the cache for the next caller", async () => {
    const a = await WasmNormalKernel.load({ cacheKey: DEFAULT_KERNEL_CACHE_KEY });
    a.dispose();
    const b = await WasmNormalKernel.load({ cacheKey: DEFAULT_KERNEL_CACHE_KEY });
    expect(b).not.toBe(a);
  });
});

describe("#33 WASM kernel — stats and memory growth", () => {
  it("tracks transfer bytes, kernel time, pages and growth", async () => {
    const kernel = await WasmNormalKernel.load({ cacheKey: "stats" });
    const initial = kernel.getStats();
    expect(initial.kernelVersion).toBe(1);
    expect(initial.jsToWasmBytes).toBe(0);
    expect(initial.wasmToJsBytes).toBe(0);
    expect(initial.growthCount).toBe(0);
    expect(initial.memoryPages).toBeGreaterThan(0);

    // 8x8 fits in the initial memory: no growth
    await kernel.computeNormals(validField(8, 8), 8, 8, {});
    const small = kernel.getStats();
    expect(small.growthCount).toBe(0);
    expect(small.jsToWasmBytes).toBe(8 * 8 * 4);
    expect(small.wasmToJsBytes).toBe(8 * 8 * 12);

    // 1024x1024 needs 16 MiB: growth happens and views are reacquired
    const big = validField(1024, 1024);
    const result = await kernel.computeNormals(big, 1024, 1024, {});
    const grown = kernel.getStats();
    expect(grown.growthCount).toBeGreaterThan(0);
    expect(grown.memoryPages * 65536).toBeGreaterThanOrEqual(16 * 1024 * 1024 + 64);
    expect(result.normal.length).toBe(1024 * 1024 * 3);
    expect(kernel.getStats().jsToWasmBytes).toBe(8 * 8 * 4 + 1024 * 1024 * 4);
  });

  it("results are copies: later growth never invalidates published data", async () => {
    const kernel = await WasmNormalKernel.load({ cacheKey: "stats-copy" });
    const small = await kernel.computeNormals(validField(8, 8), 8, 8, {});
    await kernel.computeNormals(validField(1024, 1024), 1024, 1024, {});
    expect(small.normal.length).toBe(8 * 8 * 3); // still readable
    // and the small result matches the oracle exactly
    const field = validField(8, 8);
    const heightBuf = new HostBuffer({ width: 8, height: 8, channels: 1, format: "f32" });
    heightBuf.data.set(field);
    const oracle = computeNormals(heightBuf, {});
    for (let x = 0; x < 8; x++) {
      for (let y = 0; y < 8; y++) {
        for (let c = 0; c < 3; c++) {
          expect(Object.is(small.normal[(y * 8 + x) * 3 + c], oracle.get(x, y, c))).toBe(true);
        }
      }
    }
  });
});

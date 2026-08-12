import { NORMAL_KERNEL_BASE64 } from "./normal-kernel.base64";
import type { NormalOptions } from "../lighting";
import { NORMAL_SPEC } from "../types";

/**
 * #33 WASM normal-kernel runtime wrapper.
 *
 * Owns ONE `WebAssembly.Instance` of the deterministic normal-generation
 * module (scripts/build-wasm.mjs -> normal-kernel.base64.ts) and exposes a
 * batched, validated compute API:
 *
 * - ALL input/output flows through typed-array views over the module's
 *   `WebAssembly.Memory`; a single `compute_normals` call processes the whole
 *   field (no per-pixel JS/WASM calls).
 * - The host validates dimensions, byte counts, offsets, alignment,
 *   overflow and memory bounds BEFORE invoking any export.
 * - Memory growth is host-driven (`memory.grow`); every view is REACQUIRED
 *   after growth — no detached/stale views are ever kept. Results are copied
 *   out of wasm memory immediately, so later growth can never invalidate a
 *   published result.
 * - Concurrent loads of the same module identity are deduplicated through a
 *   shared promise cache; a failed load is removed from the cache so a
 *   retry starts fresh and never poisons WebGPU or future attempts.
 * - `AbortSignal` cancellation is honored at every JS stage boundary; a
 *   cancelled compute rejects with an AbortError and NEVER publishes a
 *   partial result (the kernel call itself is synchronous and atomic).
 * - Disposal is idempotent: after `dispose()` new work is rejected, the
 *   cache entry is released, and late async completions are ignored.
 *
 * Same-thread by design (no worker): the kernel is a single synchronous
 * batch call with zero per-pixel JS traffic, and the rest of the fallback
 * pipeline (composition/shadow/lighting) is the TypeScript oracle that runs
 * on this thread anyway — see WasmCpuPipeline for the full rationale.
 */

/** Memory layout contract of the kernel module (bytes). */
export const NORMAL_KERNEL_INPUT_BASE = 0;
export const NORMAL_KERNEL_INPUT_BYTES_PER_TEXEL = 4;
export const NORMAL_KERNEL_OUTPUT_BYTES_PER_TEXEL = 12;
/** The kernel reads/writes `16 * width * height` bytes plus guard slack. */
export const NORMAL_KERNEL_WORK_BYTES_PER_TEXEL = 16;
export const NORMAL_KERNEL_GUARD_BYTES = 64;
/** u32-bounded texel count ceiling (host-side overflow validation). */
export const NORMAL_KERNEL_MAX_TEXELS = Math.floor(
  (0x7fffffff - NORMAL_KERNEL_GUARD_BYTES) / NORMAL_KERNEL_WORK_BYTES_PER_TEXEL,
);

export const DEFAULT_WASM_PAGE_BYTES = 65536;

export interface WasmKernelLoadOptions {
  /**
   * Module bytes. Defaults to the checked-in deterministic module
   * (normal-kernel.base64.ts). A caller-supplied module must export the
   * same ABI: `memory`, `compute_normals(width, height, scaleX, scaleY,
   * normalScale) -> i32` and `kernel_version() -> i32`.
   */
  bytes?: Uint8Array;
  /** Shared-load cache key (default: the default-module identity). */
  cacheKey?: string;
  /** Initial memory size in pages (default 1 = 64 KiB). */
  initialPages?: number;
}

export interface WasmKernelStats {
  /** kernel ABI version reported by the module (1). */
  kernelVersion: number;
  /** Wall-clock module load time (compile + instantiate), ms. */
  loadMs: number;
  /** Cumulative bytes written JS -> wasm memory. */
  jsToWasmBytes: number;
  /** Cumulative bytes read wasm memory -> JS. */
  wasmToJsBytes: number;
  /** Wall-clock transfer time of the LAST compute (write + copy-out), ms. */
  transferMs: number;
  /** Wall-clock kernel invocation time of the LAST compute, ms. */
  kernelMs: number;
  /** Current memory size in pages. */
  memoryPages: number;
  /** Cumulative `memory.grow` events. */
  growthCount: number;
}

export interface WasmNormalComputeResult {
  /** Copy of the f32 xyz normal field (never a live wasm view). */
  normal: Float32Array;
  /** Spec of the returned normal buffer (NORMAL_SPEC(width, height)). */
  spec: ReturnType<typeof NORMAL_SPEC>;
  /** Stats snapshot AFTER this compute. */
  stats: WasmKernelStats;
}

function abortedError(signal: AbortSignal): Error {
  const err = new Error("WasmNormalKernel: operation aborted");
  err.name = "AbortError";
  return err;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw abortedError(signal);
  }
}

function decodeDefaultModule(): Uint8Array {
  const text = atob(NORMAL_KERNEL_BASE64);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    bytes[i] = text.charCodeAt(i);
  }
  return bytes;
}

export const DEFAULT_KERNEL_CACHE_KEY = "ukibori-normal-kernel-v1";

/**
 * Shared COMPILATION cache: concurrent loads with the same cache key share
 * the expensive `WebAssembly.compile` step (the compiled Module is
 * immutable and safe to share). Each load() caller receives its OWN live
 * instance (instantiate is cheap); disposing an instance NEVER touches the
 * compiled-module cache, so one owner's lifecycle cannot evict the shared
 * compilation out from under another owner (nor the probe kernel, which is
 * the decision computation's private instance).
 *
 * The cache persists INDEPENDENTLY of live instances until
 * `resetKernelLoadCache()` (or a failed compile, which removes the entry so
 * retries start fresh). It is bounded by the number of distinct cache keys.
 * A key is bound to its FIRST module bytes: loading DIFFERENT bytes under
 * an already-bound key is rejected (callers using custom modules must use a
 * unique cacheKey) — a silent reuse of the wrong module is never possible.
 */
interface ModuleEntry {
  module: WebAssembly.Module;
  sourceBytes: Uint8Array;
}
const moduleCache = new Map<string, Promise<ModuleEntry>>();

/** Clear the shared-compilation cache (test/lifecycle seam). */
export function resetKernelLoadCache(): void {
  moduleCache.clear();
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

export class WasmNormalKernel {
  /** Reject new work after disposal; idempotent. */
  private disposed = false;
  private readonly instance: WebAssembly.Instance;
  private readonly memory: WebAssembly.Memory;
  private readonly computeNormalsFn: (
    width: number,
    height: number,
    scaleX: number,
    scaleY: number,
    normalScale: number,
  ) => number;
  private readonly stats: WasmKernelStats;

  private constructor(
    instance: WebAssembly.Instance,
    loadMs: number,
  ) {
    this.instance = instance;
    const exports = instance.exports as Record<string, unknown>;
    const memory = exports.memory as WebAssembly.Memory | undefined;
    const fn = exports.compute_normals as
      | ((w: number, h: number, sx: number, sy: number, nz: number) => number)
      | undefined;
    const version = exports.kernel_version as (() => number) | undefined;
    if (!(memory instanceof WebAssembly.Memory) || typeof fn !== "function" || typeof version !== "function") {
      throw new TypeError(
        "WasmNormalKernel: module does not export the expected ABI " +
          "(memory, compute_normals, kernel_version)",
      );
    }
    this.memory = memory;
    this.computeNormalsFn = fn;
    this.stats = {
      kernelVersion: version(),
      loadMs,
      jsToWasmBytes: 0,
      wasmToJsBytes: 0,
      transferMs: 0,
      kernelMs: 0,
      memoryPages: memory.buffer.byteLength / DEFAULT_WASM_PAGE_BYTES,
      growthCount: 0,
    };
    if (this.stats.kernelVersion !== 1) {
      throw new TypeError(
        `WasmNormalKernel: unsupported kernel ABI version ${this.stats.kernelVersion} (expected 1)`,
      );
    }
  }

  /** Current stats snapshot. */
  getStats(): WasmKernelStats {
    return { ...this.stats, memoryPages: this.memory.buffer.byteLength / DEFAULT_WASM_PAGE_BYTES };
  }

  get kernelVersion(): number {
    return this.stats.kernelVersion;
  }

  /** True after dispose(): the instance must not be used for new work. */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Load the kernel module. Concurrent loads with the same cache key SHARE
   * the compilation (the expensive step) but each caller receives an
   * independent live instance: disposing one owner's kernel never
   * invalidates another owner, and the compiled module persists in the
   * shared cache until `resetKernelLoadCache()` (or a failed compile). A
   * cache key is bound to its first module bytes — different bytes under an
   * already-bound key are rejected (custom modules require a unique
   * cacheKey). `signal` cancels the CALLER's wait — the underlying shared
   * compile keeps running and stays cached, so a retry after abort is fast.
   */
  static load(
    options: WasmKernelLoadOptions = {},
    signal?: AbortSignal,
  ): Promise<WasmNormalKernel> {
    const cacheKey = options.cacheKey ?? DEFAULT_KERNEL_CACHE_KEY;
    const startMs = performance.now();
    const bytes = options.bytes ?? decodeDefaultModule();
    const getEntry = (): Promise<ModuleEntry> => {
      let entry = moduleCache.get(cacheKey);
      if (entry === undefined) {
        // V8 transfers (detaches) a typed array passed straight to
        // WebAssembly.instantiate — compile the Module once (copies) and
        // instantiate per caller; the module bytes stay usable.
        const sourceBytes = bytes.slice();
        entry = WebAssembly.compile(sourceBytes.slice()).then(
          (module) => ({ module, sourceBytes }),
        );
        const pendingEntry = entry;
        entry.catch(() => {
          if (moduleCache.get(cacheKey) === pendingEntry) {
            moduleCache.delete(cacheKey);
          }
        });
        moduleCache.set(cacheKey, entry);
        return entry;
      }
      return entry.then((existing) => {
        if (!bytesEqual(bytes, existing.sourceBytes)) {
          throw new TypeError(
            `WasmNormalKernel: cacheKey "${cacheKey}" is already bound to different module ` +
              `bytes — custom modules require a unique cacheKey (never reuse the default key)`,
          );
        }
        return existing;
      });
    };
    return withAbort(getEntry(), signal).then(async (entry) => {
      const instance = await WebAssembly.instantiate(entry.module, {});
      return new WasmNormalKernel(instance, performance.now() - startMs);
    });
  }

  /**
   * Batched normal generation for one height field.
   *
   * Validation (all host-side, before any export is invoked):
   * - `width`/`height` are positive integers
   * - `texels = width * height` is a safe integer below the u32 ceiling
   * - byte counts (`4n` input, `12n` output, `16n` working set) do not
   *   overflow and fit the memory maximum
   * - the input view's byteLength is exactly `4n` and 4-byte aligned
   *
   * After any `memory.grow` the input/output views are REACQUIRED from the
   * current buffer. The result is a COPY (never a live wasm view).
   */
  async computeNormals(
    input: Uint8Array | Float32Array,
    width: number,
    height: number,
    options: NormalOptions = {},
    signal?: AbortSignal,
  ): Promise<WasmNormalComputeResult> {
    if (this.disposed) {
      throw new Error("WasmNormalKernel: kernel is disposed");
    }
    throwIfAborted(signal);
    validateDimensions(width, height);
    const texels = width * height;
    const inputBytes = texels * NORMAL_KERNEL_INPUT_BYTES_PER_TEXEL;
    const outputBytes = texels * NORMAL_KERNEL_OUTPUT_BYTES_PER_TEXEL;
    const workBytes = texels * NORMAL_KERNEL_WORK_BYTES_PER_TEXEL + NORMAL_KERNEL_GUARD_BYTES;
    if (!Number.isSafeInteger(texels) || texels > NORMAL_KERNEL_MAX_TEXELS) {
      throw new RangeError(
        `WasmNormalKernel: texel count ${texels} exceeds the u32-bounded ceiling ` +
          `${NORMAL_KERNEL_MAX_TEXELS}`,
      );
    }
    if (input instanceof Float32Array) {
      if (input.length !== texels) {
        throw new RangeError(
          `WasmNormalKernel: expected ${texels} f32 height samples, got ${input.length}`,
        );
      }
    } else {
      if (input.byteLength !== inputBytes) {
        throw new RangeError(
          `WasmNormalKernel: expected ${inputBytes} input bytes for ${texels} texels, got ${input.byteLength}`,
        );
      }
      if (input.byteOffset % 4 !== 0) {
        throw new RangeError("WasmNormalKernel: input must be 4-byte aligned");
      }
    }
    const scaleX = options.scaleX ?? 0.5;
    const scaleY = options.scaleY ?? 0.5;
    const normalScale = options.normalScale ?? 1;
    if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || !Number.isFinite(normalScale) || normalScale <= 0) {
      throw new RangeError("WasmNormalKernel: scaleX/scaleY must be finite and normalScale finite > 0");
    }

    // ---- grow memory if needed; reacquire views AFTER any growth ----
    if (workBytes > this.memory.buffer.byteLength) {
      const pages = Math.ceil(
        (workBytes - this.memory.buffer.byteLength) / DEFAULT_WASM_PAGE_BYTES,
      );
      const previous = this.memory.buffer.byteLength;
      const grown = this.memory.grow(pages);
      if (grown < 0) {
        throw new RangeError(
          `WasmNormalKernel: memory.grow(${pages}) failed (need ${workBytes} bytes, max ${this.memory.buffer.byteLength})`,
        );
      }
      this.stats.growthCount += 1;
      this.stats.memoryPages = this.memory.buffer.byteLength / DEFAULT_WASM_PAGE_BYTES;
      void previous;
    }
    throwIfAborted(signal);

    // ---- transfer in (fresh views; never cached across grow) ----
    const transferStart = performance.now();
    const inputView = new Float32Array(this.memory.buffer, NORMAL_KERNEL_INPUT_BASE, texels);
    if (input instanceof Float32Array) {
      inputView.set(input);
    } else {
      inputView.set(new Float32Array(input.buffer, input.byteOffset, texels));
    }
    this.stats.jsToWasmBytes += inputBytes;
    throwIfAborted(signal);

    // ---- the single batched kernel call ----
    const kernelStart = performance.now();
    const result = this.computeNormalsFn(width, height, scaleX, scaleY, normalScale);
    const kernelMs = performance.now() - kernelStart;
    if (result !== 0) {
      throw new Error(`WasmNormalKernel: kernel returned ${result}`);
    }
    this.stats.kernelMs = kernelMs;

    // ---- copy out (copy, never a live view) ----
    const outputView = new Float32Array(
      this.memory.buffer,
      inputBytes,
      texels * 3,
    );
    const normal = new Float32Array(outputView);
    this.stats.wasmToJsBytes += outputBytes;
    this.stats.transferMs = performance.now() - transferStart;
    this.stats.memoryPages = this.memory.buffer.byteLength / DEFAULT_WASM_PAGE_BYTES;
    throwIfAborted(signal);

    return { normal, spec: NORMAL_SPEC(width, height), stats: this.getStats() };
  }

  /**
   * Idempotent disposal of THIS owner's instance: rejects new work through
   * this kernel. The shared compiled module is NOT touched — other owners'
   * instances remain fully usable, and the compilation persists in the
   * shared cache until `resetKernelLoadCache()`. Late async completions are
   * ignored (their results are plain copies; disposal is the only
   * mutation).
   */
  dispose(): void {
    this.disposed = true;
  }
}

function validateDimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new RangeError(`WasmNormalKernel: invalid dimensions ${width}x${height}`);
  }
}

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(abortedError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortedError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export { decodeDefaultModule };

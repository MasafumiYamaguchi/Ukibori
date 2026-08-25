import { composeCasterHeightField, composeSdfHeightField } from "../geometry";
import { computeVisibility } from "../shadow";
import { reconstructVisibility, sanitizeReconstructionOptions } from "../shadow-reconstruct";
import { sanitizeAngularRadius, sanitizeShadowSamples } from "../shadow-sampling";
import { shadePreparedFields } from "../lighting";
import type { LightingBuffers, LightingOptions } from "../lighting";
import { HostBuffer } from "../buffer";
import type { Scene } from "../scene";
import type { WasmKernelStats } from "./kernel";
import { WasmNormalKernel } from "./kernel";
import type { WasmSelectionReport } from "./selection";

/**
 * #33 WASM-assisted CPU fallback pipeline.
 *
 * Consumes the existing canonical `Scene` contract and composes the COMPLETE
 * fallback output through the existing reference stages:
 *
 * ```text
 *   composeSdfHeightField (TypeScript oracle)
 *        -> WASM normal kernel (the ONLY WASM stage)
 *        -> computeVisibility (TypeScript oracle)
 *        -> reconstructVisibility (#43 oracle; bypassed on hard frames)
 *        -> shadePreparedFields (TypeScript oracle)
 * ```
 *
 * The TypeScript CPU implementation remains the semantic oracle; exactly ONE
 * measured, batch-friendly dense-field bottleneck (normal generation) runs
 * in WASM. Every result carries a per-stage provenance report
 * (`wasmStages`) that states which stage ACTUALLY ran in WASM — a
 * TypeScript-only execution is never labeled as WASM.
 *
 * Parity: the WASM normal field is bit-identical to `computeNormals` (see
 * src/wasm/kernel.test.ts), so the downstream oracle stages receive exactly
 * the inputs the pure-TypeScript path would produce, and the full output
 * (height/normal/visibility/diffuse/specular/color) matches `lightScene`
 * byte-for-byte — preserving the established #13-#21 semantics and the #22
 * color cases (the CPU goldens verify those independently).
 *
 * Cancellation: `AbortSignal` is honored at every JS stage boundary (before
 * the kernel, between stages, before publishing). The kernel call itself is
 * one synchronous batch call; a cancelled render rejects with an AbortError
 * and NEVER publishes a cancelled or partially computed result.
 *
 * Same-thread by design (no worker): the kernel is a single synchronous
 * batch call with zero per-pixel JS traffic, and the composition / shadow /
 * lighting stages are the TypeScript oracle which must run on this thread
 * regardless. A worker would therefore only offload the fastest fraction of
 * the fallback path while adding request-ID/transfer/cancellation machinery
 * for no measured gain; the initial implementation stays same-thread.
 */
export interface WasmPipelineOptions {
  /** Pre-loaded kernel (defaults to the shared deterministic load). */
  kernel?: WasmNormalKernel;
  /** Selection evidence to attach to the report (probe, decision). */
  selection?: WasmSelectionReport;
}

export interface WasmRenderRequest {
  scene: Scene;
  /** Normal/shadow/lighting options — same shape as `lightScene` options. */
  lighting?: LightingOptions;
  /** Cancellation at JS stage boundaries. */
  signal?: AbortSignal;
}

/** Per-stage provenance: which stage actually executed in WASM. */
export interface WasmStageProvenance {
  height: "typescript";
  objectId: "typescript";
  normal: "wasm";
  visibility: "typescript";
  lighting: "typescript";
}

export interface WasmRenderResult extends LightingBuffers {
  /** Never labeled WASM unless the WASM stage genuinely ran. */
  wasmStages: WasmStageProvenance;
  /** Kernel stats snapshot from the WASM normal stage. */
  wasmStats: WasmKernelStats;
  /** Wall-clock total of this render (host time), ms. */
  totalMs: number;
}

function abortedError(): Error {
  const err = new Error("WasmCpuPipeline: render aborted");
  err.name = "AbortError";
  return err;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw abortedError();
  }
}

export class WasmCpuPipeline {
  readonly kernel: WasmNormalKernel;
  readonly selection: WasmSelectionReport | null;
  private disposed = false;

  constructor(options: WasmPipelineOptions = {}) {
    if (options.kernel === undefined) {
      throw new TypeError(
        "WasmCpuPipeline: kernel required — construct via WasmCpuPipeline.load()",
      );
    }
    this.kernel = options.kernel;
    this.selection = options.selection ?? null;
  }

  /** Load the default kernel (deduplicated) and build the pipeline. */
  static async load(
    options: WasmPipelineOptions = {},
    signal?: AbortSignal,
  ): Promise<WasmCpuPipeline> {
    const kernel = options.kernel ?? (await WasmNormalKernel.load({}, signal));
    return new WasmCpuPipeline({ kernel, selection: options.selection });
  }

  /**
   * Render the complete fallback output for a scene. The height/ownership
   * composition and the shadow/lighting stages are the existing TypeScript
   * oracle; ONLY the normal stage runs in WASM (reported in `wasmStages`).
   */
  async render(request: WasmRenderRequest): Promise<WasmRenderResult> {
    if (this.disposed) {
      throw new Error("WasmCpuPipeline has been disposed");
    }
    const { scene, lighting = {}, signal } = request;
    const started = performance.now();
    throwIfAborted(signal);

    // ---- stage 1: composition (TypeScript oracle) ----
    const composed = composeSdfHeightField(scene);
    throwIfAborted(signal);

    // ---- stage 2: normal generation (WASM kernel) ----
    const heightBytes = new Uint8Array(
      composed.height.data.buffer,
      composed.height.data.byteOffset,
      composed.height.data.byteLength,
    );
    const wasmResult = await this.kernel.computeNormals(
      heightBytes,
      scene.width,
      scene.height,
      lighting.normal,
      signal,
    );
    throwIfAborted(signal);

    // ---- stage 3: cast shadows (TypeScript oracle) ----
    const needsCasterField = scene.surfaces.some((s) => !s.castsShadow);
    const shadowOptions = lighting.shadow ?? {};
    const visibility = computeVisibility(scene, composed.height, {
      ...shadowOptions,
      objectId: composed.objectId,
      casterHeight: needsCasterField ? composeCasterHeightField(scene) : undefined,
    });
    throwIfAborted(signal);

    // ---- stage 3b: #43 edge-aware reconstruction (TypeScript oracle) ----
    // Mirrors lightScene exactly: hard-path frames and disabled options keep
    // the raw field, soft frames consume the reconstructed one.
    const softActive =
      sanitizeAngularRadius(
        typeof scene.light.angularRadius === "number" ? scene.light.angularRadius : undefined,
      ) > 0 && sanitizeShadowSamples(shadowOptions.samples) > 1;
    const reconstructedVisibility =
      softActive && sanitizeReconstructionOptions(shadowOptions.reconstruction).enabled
        ? reconstructVisibility(visibility, composed.height, {
            objectId: composed.objectId,
          }, shadowOptions.reconstruction)
        : visibility;
    throwIfAborted(signal);

    // ---- stage 4: BRDF + environment + exposure (TypeScript oracle) ----
    const normal = new HostBuffer(wasmResult.spec);
    normal.writeBytes(new Uint8Array(wasmResult.normal.buffer));
    const shaded = shadePreparedFields(
      scene,
      { normal, objectId: composed.objectId, visibility: reconstructedVisibility },
      lighting,
    );
    throwIfAborted(signal);

    return {
      height: composed.height,
      normal,
      diffuse: shaded.diffuse,
      specular: shaded.specular,
      color: shaded.color,
      visibility: shaded.visibility,
      wasmStages: {
        height: "typescript",
        objectId: "typescript",
        normal: "wasm",
        visibility: "typescript",
        lighting: "typescript",
      },
      wasmStats: wasmResult.stats,
      totalMs: performance.now() - started,
    };
  }

  /** Idempotent disposal: rejects new work; releases the kernel reference. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.kernel.dispose();
  }
}

import type { EncodedScene } from "./encode";
import { parseHeader } from "./encode";
import {
  FLAG_CASTS_SHADOW,
  GPU_USAGE_COPY_DST,
  GPU_USAGE_COPY_SRC,
  GPU_USAGE_STORAGE,
  HEADER_SIZE,
  SURFACE_OFFSET_ELEVATION,
  SURFACE_OFFSET_FLAGS,
  SURFACE_OFFSET_THICKNESS,
  SURFACE_STRIDE,
} from "./layout";
import type { GpuBufferLike, SceneBindings } from "./uploader";
import type { BandRegion } from "./tiles";
import { assertBandRegion } from "./tiles";
import { validateEncodedScene } from "./validate";
import {
  COMPUTE_STAGE_VISIBILITY,
  GPU_USAGE_UNIFORM,
} from "./height-pass";
import type {
  GpuBindGroupLayoutLike,
  GpuBindGroupLike,
  GpuComputeDeviceLike,
  GpuComputePipelineLike,
  GpuLimitsLike,
  GpuPipelineLayoutLike,
  GpuShaderModuleLike,
  HeightPassProvenance,
  HeightPassSnapshot,
} from "./height-pass";
import type { ShadowOptions } from "../shadow";
import {
  MAX_SHADOW_STEP_COUNT,
  SHADOW_OUTPUT_BYTES_PER_TEXEL,
  SHADOW_PARAMS_BYTE_LENGTH,
  SHADOW_PASS_WGSL,
  SHADOW_WORKGROUP_SIZE,
} from "./shadow-pass-wgsl";

/**
 * #27 GPU shadow visibility stage — a real WebGPU compute pass that
 * produces the reusable, GPU-resident hard shadow visibility field from the
 * #25 height/ownership data with NO height/ownership/visibility readback in
 * normal execution. The CPU implementation (`shadow.ts`) stays as the
 * reference and fallback; this module mirrors it exactly (see the fixed
 * semantics in `shadow-pass-wgsl.ts`).
 *
 * ## Direct #25/#24 bindings
 *
 * `dispatch()` binds the EXACT `HeightPass.getSnapshot()` height,
 * casterHeight and objectId buffers (built with
 * `shadowHeightBindingsFromHeightPass`, never copied into new input
 * allocations) plus the exact uploaded surface records
 * (`input.bindings.surfaces`), which are consulted ONLY for the
 * `FLAG_RECEIVES_SHADOW` bit. These fields are never copied into
 * JavaScript arrays or replacement GPU inputs.
 *
 * ## Provenance / structural checks before ANY device call
 *
 * In order, before any allocation/write/pipeline/bind-group/encoder call:
 *
 * 1. strict byte-level `validateEncodedScene` (rejected with the collected
 *    errors)
 * 2. `bindings.provenance` must be the exact `scene.bytes` object (O(1)
 *    identity), and `bindings.sceneByteLength` must equal the header total
 * 3. the surfaces section byte length must equal
 *    `surfaceCount * SURFACE_STRIDE` and the buffer must be large enough
 * 4. height/casterHeight/objectId must share the exact per-dispatch
 *    `HeightPassSnapshot.provenance` object, whose `sceneBytes` must be the
 *    exact `scene.bytes`; this rejects FOREIGN scenes and MIXED fields from
 *    separate dispatches of the same scene before any device call
 * 5. render width/height positive integers; the render texel count must
 *    fit safe integers and u32 (it is packed into the uniform and used by
 *    in-shader u32 products)
 * 6. the height/casterHeight/objectId bindings must match the header
 *    extent (width/height), their formats (`f32`/`u32`), logical byte
 *    lengths (`width * height * 4`) and STORAGE usage, and their buffer
 *    sizes must cover the logical bytes
 * 7. workgroup-size limits (`maxComputeWorkgroupSizeX`,
 *    `maxComputeInvocationsPerWorkgroup`) and dispatch-count limits
 *    (`maxComputeWorkgroupsPerDimension`)
 * 8. every explicit storage binding range is bounded by
 *    `maxStorageBufferBindingSize`, and pass-owned allocations are also
 *    bounded by `maxBufferSize`
 * 9. the sanitized march `stepCount` must be within `MAX_SHADOW_STEP_COUNT`
 *    (a scene so large that even the stable defaults exceed the cap is
 *    rejected before any device call, and a custom step that rounds to
 *    zero or forces an absurd step count already fell back to the default)
 *
 * ## Effective option sanitization (documented and pinned by tests)
 *
 * `sanitizeShadowOptions` maps each option to a finite f32 value. Every
 * option is judged AFTER f32 rounding (`Math.fround`):
 *
 * - non-finite raw values (NaN, +/-Infinity) fall back to the stable
 *   default (`stepSize` 0.5, `bias` f32(0.5), `maxDistance`
 *   `sceneDiagonal / |L.xy|` when `|L.xy| > 1e-6`, else `sceneDiagonal`)
 * - raw finite values that round to a non-finite f32 fall back (they
 *   cannot be packed into a finite f32)
 * - `stepSize`/`maxDistance` must round strictly positive and `bias`
 *   non-negative, else the default is used; a step that would require more
 *   than `MAX_SHADOW_STEP_COUNT` iterations (e.g. a positive subnormal)
 *   also falls back to 0.5 so a zero/underflowed value can never create a
 *   non-terminating WGSL loop
 * - representable finite values are rounded to f32 and packed into the
 *   uniform little-endian
 *
 * ## Conservative maxCasterHeight (no GPU readback)
 *
 * `maxCasterHeight = max(f32(elevation) + f32(thickness))` over the CASTING
 * ABI surface records is derived from the already CPU-resident, strictly
 * validated `scene.bytes` (host-side DataView reads; the f32 sums use the
 * exact packed values, so the bound equals the shader's f32 flat-top
 * value). The GPU height field is NEVER scanned on the host. Because it is
 * an upper bound on every caster-field sample, the early-exit test
 * `rayZ > maxCasterHeight + bias` cannot change visibility.
 *
 * ## Output
 *
 * One tightly packed row-major scalar f32 per texel
 * (`SHADOW_OUTPUT_BYTES_PER_TEXEL = 4` logical bytes per texel). The
 * production allocation is `STORAGE | COPY_SRC | COPY_DST`, never mapped,
 * and exposed through the stable read-only snapshot. Normal-frame execution
 * performs only a uniform upload and a compute submission — no map, no
 * readback. Updating only shadow options rewrites the bounded uniform and
 * redispatches; all input/output allocations and the cached pipeline are
 * reused.
 *
 * ## Structural device interface
 *
 * The class drives the same narrow structural `GpuComputeDeviceLike` mirror
 * as `HeightPass` (the real `GPUDevice` cast is the only boundary; the Node
 * test mock implements the same surface, so no fabricated WebGPU methods
 * exist).
 */
export const SHADOW_PASS_OUTPUT_USAGE =
  GPU_USAGE_STORAGE | GPU_USAGE_COPY_SRC | GPU_USAGE_COPY_DST;

/** Largest u32 value; the texel count packed into the uniform must fit it. */
const U32_MAX = 0xffffffff;

/** Default `maxStorageBufferBindingSize` / `maxBufferSize` (spec minimum). */
const DEFAULT_MAX_STORAGE_BYTES = 256 * 1024 * 1024;

/** Default `maxComputeWorkgroupsPerDimension` (spec minimum). */
const DEFAULT_MAX_WORKGROUPS = 65535;

/** Smallest legal allocation for pass-owned buffers. */
const MIN_PASS_ALLOCATION_BYTES = 16;

const DEFAULT_STEP_SIZE = 0.5;
const DEFAULT_BIAS = 0.5;

/** Host binding view of a #25 scalar field output (narrow structural type). */
export interface ShadowFieldBinding {
  /** the EXACT #25 output buffer (never a copy) */
  readonly buffer: GpuBufferLike;
  /** logical field bytes (== width * height * 4) */
  readonly byteLength: number;
  /** #25 output format; f32 for heights, u32 for objectId */
  readonly format: "f32" | "u32";
  /** must include STORAGE (the shader reads the buffer as storage) */
  readonly usage: number;
  /** render extent width (texels) */
  readonly width: number;
  /** render extent height (texels) */
  readonly height: number;
  /**
   * O(1) identity of the successful #25 dispatch this field came from.
   * Every field in one ShadowPass input must share this exact object; its
   * `sceneBytes` must also match the dispatched encoded scene.
   */
  readonly provenance: HeightPassProvenance;
}

/** Effective (sanitized + f32-rounded) shadow options actually dispatched. */
export interface ShadowEffectiveOptions {
  readonly stepSize: number;
  readonly bias: number;
  readonly maxDistance: number;
}

/** Sanitization context: the #17-compatible stable defaults. */
export interface ShadowSanitizeContext {
  /** logical scene diagonal in scene units (maxDistance default base) */
  readonly sceneDiagonal: number;
  /** |light.xy| of the f32-packed light direction */
  readonly lightXYLength: number;
}

export interface ShadowPassInput {
  /** the EXACT encoded scene (bytes provenance + header, strict-validated) */
  readonly scene: EncodedScene;
  /** the EXACT SceneUploader bindings whose provenance is `scene.bytes` */
  readonly bindings: SceneBindings;
  /** #25 full visible height binding, consumed DIRECTLY */
  readonly height: ShadowFieldBinding;
  /** #27 caster-only height binding, consumed DIRECTLY */
  readonly casterHeight: ShadowFieldBinding;
  /** #25 object-id binding, consumed DIRECTLY */
  readonly objectId: ShadowFieldBinding;
  /** CPU-compatible shadow options; sanitized like the oracle */
  readonly options?: ShadowOptions;
  /**
   * #32 optional dispatch region (inclusive texel rows): only those rows
   * are computed (`ceil(bandTexels / SHADOW_WORKGROUP_SIZE)` workgroups;
   * the in-shader index adds `y0 * width`), so texels outside the band are
   * never written. The march samples the retained height fields outside the
   * band (the scheduler guarantees they are unaffected). Bounds-safe by
   * construction; `undefined` keeps the historical full-frame dispatch.
   */
  readonly region?: BandRegion;
}

/** Stable read-only output binding for later lighting/presentation. */
export interface ShadowOutputBinding {
  /** GPU allocation (never undefined after the first dispatch) */
  readonly buffer: GpuBufferLike;
  /** logical bytes == 4 * width * height (tightly packed f32 scalars) */
  readonly byteLength: number;
  readonly format: "f32";
  /** one tightly packed f32 scalar per texel */
  readonly channels: 1;
  /** `STORAGE | COPY_SRC | COPY_DST` */
  readonly usage: number;
}

export interface ShadowPassLastDispatch {
  readonly renderWidth: number;
  readonly renderHeight: number;
  /** ceil(texels / SHADOW_WORKGROUP_SIZE) */
  readonly workgroupCountX: number;
  /** sanitized in-shader march iteration count (<= MAX_SHADOW_STEP_COUNT) */
  readonly stepCount: number;
  readonly surfaceCount: number;
  /** number of ABI surfaces with FLAG_CASTS_SHADOW */
  readonly casterSurfaceCount: number;
  /** host-derived conservative caster-top bound (f32) */
  readonly maxCasterHeight: number;
  /** false when every invocation returns 1.0 without marching */
  readonly hasCasters: boolean;
}

/** Stable read-only snapshot of the visibility field after the last dispatch. */
export interface ShadowPassSnapshot {
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
  readonly workgroupSize: number;
  readonly output: ShadowOutputBinding;
  /** the effective (sanitized, f32-rounded) options that ran */
  readonly options: ShadowEffectiveOptions;
  readonly lastDispatch: ShadowPassLastDispatch;
  /**
   * The per-HeightPass-dispatch provenance propagated from the #25 height
   * bindings (#28): the lighting stage requires every field to share this
   * exact token so foreign/mixed fields are rejected before any device call.
   */
  readonly provenance: HeightPassProvenance;
}

export interface ShadowPassDispatchStats {
  readonly newAllocations: number;
  readonly allocationCount: number;
  readonly totalAllocationBytes: number;
  readonly workgroupCountX: number;
}

/**
 * Sanitize `ShadowOptions` to the effective values packed to the GPU (see
 * class docs for the policy). Defaults stay #17-compatible: `stepSize =
 * 0.5`, `bias = f32(0.5)`, `maxDistance = sceneDiagonal / |L.xy|` when
 * `|L.xy| > 1e-6`, else `sceneDiagonal`.
 *
 * Every option — INCLUDING the default/fallback `maxDistance` — is
 * f32-packed (`Math.fround`) BEFORE the step count, snapshot and uniform
 * are derived, so the snapshot's effective options, the packed uniform and
 * the in-shader termination count always agree exactly.
 *
 * Every raw option is judged AFTER f32 rounding (`Math.fround`): the
 * rounded value must be finite and preserve the required sign (strictly
 * positive for step/maxDistance, non-negative for bias), else the default
 * is used. A step whose packed f32 rounds to zero (or one that would
 * require more than `MAX_SHADOW_STEP_COUNT` iterations) falls back to 0.5,
 * so a non-terminating WGSL loop is impossible.
 */
export function sanitizeShadowOptions(
  options: ShadowOptions = {},
  ctx: ShadowSanitizeContext,
): ShadowEffectiveOptions {
  const defaultMaxDistance = Math.fround(
    ctx.lightXYLength > 1e-6 ? ctx.sceneDiagonal / ctx.lightXYLength : ctx.sceneDiagonal,
  );
  let maxDistance = sanitizeF32StrictPositive(options.maxDistance, defaultMaxDistance);
  let stepSize = sanitizeF32StrictPositive(options.stepSize, DEFAULT_STEP_SIZE);
  let stepCount = shadowStepCount(maxDistance, stepSize);
  if (stepCount > MAX_SHADOW_STEP_COUNT) {
    stepSize = DEFAULT_STEP_SIZE;
    stepCount = shadowStepCount(maxDistance, stepSize);
  }
  if (stepCount > MAX_SHADOW_STEP_COUNT) {
    maxDistance = defaultMaxDistance;
    stepCount = shadowStepCount(maxDistance, stepSize);
  }
  return {
    stepSize,
    bias: sanitizeF32NonNegative(options.bias, DEFAULT_BIAS),
    maxDistance,
  };
}

/**
 * Build the narrow height/casterHeight/objectId bindings consumed by
 * `ShadowPass` from the #25 output snapshot — the exact output buffers, the
 * snapshot render extent, and its per-dispatch O(1) provenance token so
 * `ShadowPass` can reject foreign scenes or fields mixed across executions.
 */
export function shadowHeightBindingsFromHeightPass(snapshot: HeightPassSnapshot): {
  readonly height: ShadowFieldBinding;
  readonly casterHeight: ShadowFieldBinding;
  readonly objectId: ShadowFieldBinding;
} {
  const field = (binding: HeightPassSnapshot["outputs"]["height"]): ShadowFieldBinding => ({
    buffer: binding.buffer,
    byteLength: binding.byteLength,
    format: binding.format as "f32" | "u32",
    usage: binding.usage,
    width: snapshot.width,
    height: snapshot.height,
    provenance: snapshot.provenance,
  });
  return {
    height: field(snapshot.outputs.height),
    casterHeight: field(snapshot.outputs.casterHeight),
    objectId: field(snapshot.outputs.objectId),
  };
}

type ShadowAllocationName = "uniform" | "outVisibility";

interface CachedShadowPipeline {
  layout: GpuBindGroupLayoutLike;
  pipelineLayout: GpuPipelineLayoutLike;
  pipeline: GpuComputePipelineLike;
  module: GpuShaderModuleLike;
}

interface CasterInfo {
  readonly hasCasters: boolean;
  readonly casterSurfaceCount: number;
  readonly maxCasterHeight: number;
}

export class ShadowPass {
  private readonly allocations = new Map<ShadowAllocationName, GpuBufferLike>();
  private readonly allocationSizes = new Map<ShadowAllocationName, number>();
  private readonly uniformBytes = new Uint8Array(SHADOW_PARAMS_BYTE_LENGTH);
  private newAllocations = 0;
  private lastDispatch: ShadowPassLastDispatch | null = null;
  private lastOptions: ShadowEffectiveOptions | null = null;
  private lastDpr = 0;
  private lastProvenance: HeightPassProvenance | null = null;
  private cached: CachedShadowPipeline | null = null;

  constructor(private readonly device: GpuComputeDeviceLike) {}

  /**
   * Compute the hard shadow visibility field for one #25 snapshot bound to
   * the exact encoded scene/upload. Validation, limits and allocation
   * bounds all run BEFORE any device call; execution then performs only a
   * uniform upload and one compute submission (no map, no readback).
   * Updating options reuses the same input/output allocations: it only
   * re-packs the bounded uniform and reruns the pass.
   */
  dispatch(input: ShadowPassInput): ShadowPassDispatchStats {
    const scene = input.scene;
    const validation = validateEncodedScene(scene.bytes);
    if (!validation.ok || validation.header === undefined) {
      throw new Error(`invalid encoded scene: ${validation.errors.join("; ")}`);
    }
    const header = validation.header;
    if (input.bindings.provenance !== scene.bytes) {
      throw new Error(
        "bindings provenance does not match the dispatched scene: " +
          "upload the exact EncodedScene being dispatched and reuse its bindings",
      );
    }
    if (input.bindings.sceneByteLength !== header.totalByteLength) {
      throw new Error(
        `bindings.sceneByteLength ${input.bindings.sceneByteLength} != scene byte length ${header.totalByteLength}`,
      );
    }
    this.assertSurfacesSection(header.surfaceCount, input.bindings);
    this.assertExtent(header, scene.bytes, input);

    const parsed = parseHeader(scene.bytes);
    const texelCount = header.renderWidth * header.renderHeight;
    const sceneDiagonal = Math.hypot(header.renderWidth / header.dpr, header.renderHeight / header.dpr);
    const lightXYLength = Math.hypot(parsed.lightDirection.x, parsed.lightDirection.y);
    const options = sanitizeShadowOptions(input.options, { sceneDiagonal, lightXYLength });
    const stepCount = shadowStepCount(options.maxDistance, options.stepSize);
    if (stepCount > MAX_SHADOW_STEP_COUNT) {
      throw new Error(
        `shadow step count ${stepCount} exceeds the termination cap ${MAX_SHADOW_STEP_COUNT}: ` +
          `the scene diagonal/options are too large for a terminating march`,
      );
    }
    const workgroupCountX = Math.ceil(texelCount / SHADOW_WORKGROUP_SIZE);
    // #32 region dispatch: only the band rows are dispatched; the in-shader
    // guard is the exclusive region end, so the band stays in bounds and its
    // dispatch padding never writes a retained texel.
    const region = assertBandRegion(input.region, header.renderHeight);
    const bandRows = region === null ? header.renderHeight : region.y1 - region.y0 + 1;
    const bandTexels = header.renderWidth * bandRows;
    const dispatchCountX = Math.ceil(bandTexels / SHADOW_WORKGROUP_SIZE);
    const yOffset = region === null ? 0 : region.y0 * header.renderWidth;
    // exclusive texel end of the dispatched region: 0 = full-frame sentinel;
    // on a band the shader guard regionEnd != 0 && g >= regionEnd stops the
    // dispatch padding from ever writing a retained texel outside the band
    const regionEnd = region === null ? 0 : yOffset + bandTexels;
    this.assertDeviceLimits(dispatchCountX);
    const outputBytes = texelCount * SHADOW_OUTPUT_BYTES_PER_TEXEL;
    const fieldBindingBytes = texelCount * 4;
    const surfacesBindingBytes = Math.max(header.surfaceCount * SURFACE_STRIDE, SURFACE_STRIDE);
    this.assertStorageBindingsWithinLimit([
      ["height input", fieldBindingBytes],
      ["casterHeight input", fieldBindingBytes],
      ["objectId input", fieldBindingBytes],
      ["surfaces input", surfacesBindingBytes],
      ["shadow output", outputBytes],
    ]);
    this.assertAllocationWithinLimits(SHADOW_PARAMS_BYTE_LENGTH, "params uniform");
    this.assertAllocationWithinLimits(outputBytes, "shadow output");

    const caster = this.readCasterInfo(scene.bytes, header);

    this.ensureAllocation("uniform", SHADOW_PARAMS_BYTE_LENGTH, GPU_USAGE_UNIFORM | GPU_USAGE_COPY_DST);
    this.ensureAllocation("outVisibility", outputBytes, SHADOW_PASS_OUTPUT_USAGE);
    this.packUniform(header, parsed, options, stepCount, caster, yOffset, regionEnd);
    const uniform = this.allocation("uniform");
    this.device.queue.writeBuffer(uniform, 0, this.uniformBytes);

    const cached = this.ensurePipeline();
    const group = this.device.createBindGroup({
      label: "ukibori-shadow-pass",
      layout: cached.layout,
      entries: [
        {
          binding: 0,
          resource: { buffer: uniform, size: SHADOW_PARAMS_BYTE_LENGTH },
        },
        // #25/#27 outputs are consumed DIRECTLY (narrow structural casts at
        // this boundary, never copies into new input allocations).
        {
          binding: 1,
          resource: { buffer: input.height.buffer, size: fieldBindingBytes },
        },
        {
          binding: 2,
          resource: { buffer: input.casterHeight.buffer, size: fieldBindingBytes },
        },
        {
          binding: 3,
          resource: { buffer: input.objectId.buffer, size: fieldBindingBytes },
        },
        // Uploaded surface records: only the receivesShadow flag is read.
        {
          binding: 4,
          resource: { buffer: input.bindings.surfaces.buffer, size: surfacesBindingBytes },
        },
        {
          binding: 5,
          resource: { buffer: this.allocation("outVisibility"), size: outputBytes },
        },
      ],
    });

    const encoder = this.device.createCommandEncoder({ label: "ukibori-shadow-pass" });
    const pass = encoder.beginComputePass();
    pass.setPipeline(cached.pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(dispatchCountX);
    pass.end();
    this.device.queue.submit([encoder.finish()]);

    this.lastDispatch = {
      renderWidth: header.renderWidth,
      renderHeight: header.renderHeight,
      workgroupCountX: dispatchCountX,
      stepCount,
      surfaceCount: header.surfaceCount,
      casterSurfaceCount: caster.casterSurfaceCount,
      maxCasterHeight: caster.maxCasterHeight,
      hasCasters: caster.hasCasters,
    };
    this.lastOptions = options;
    this.lastDpr = header.dpr;
    this.lastProvenance = input.height.provenance;

    const stats: ShadowPassDispatchStats = {
      newAllocations: this.newAllocations,
      allocationCount: this.allocations.size,
      totalAllocationBytes: sumOf(this.allocationSizes),
      workgroupCountX,
    };
    this.newAllocations = 0;
    return stats;
  }

  /** Stable read-only snapshot; throws before the first successful dispatch. */
  getSnapshot(): ShadowPassSnapshot {
    if (this.lastDispatch === null || this.lastOptions === null) {
      throw new Error("no dispatch: dispatch() has not completed or dispose() was called");
    }
    const texelCount = this.lastDispatch.renderWidth * this.lastDispatch.renderHeight;
    return {
      width: this.lastDispatch.renderWidth,
      height: this.lastDispatch.renderHeight,
      dpr: this.lastDpr,
      workgroupSize: SHADOW_WORKGROUP_SIZE,
      output: {
        buffer: this.allocation("outVisibility"),
        byteLength: texelCount * SHADOW_OUTPUT_BYTES_PER_TEXEL,
        format: "f32",
        channels: 1,
        usage: SHADOW_PASS_OUTPUT_USAGE,
      },
      options: this.lastOptions,
      lastDispatch: this.lastDispatch,
      provenance: this.lastProvenance as HeightPassProvenance,
    };
  }

  /** Destroy every owned GPU allocation (never foreign input buffers). Idempotent. */
  dispose(): void {
    for (const buffer of this.allocations.values()) {
      buffer.destroy();
    }
    this.allocations.clear();
    this.allocationSizes.clear();
    this.newAllocations = 0;
    this.lastDispatch = null;
    this.lastOptions = null;
    this.lastDpr = 0;
    this.lastProvenance = null;
  }

  // -- validation (all BEFORE any device call) ------------------------------

  private assertSurfacesSection(surfaceCount: number, bindings: SceneBindings): void {
    const expectedByteLength = surfaceCount * SURFACE_STRIDE;
    if (!Number.isSafeInteger(expectedByteLength) || expectedByteLength < 0) {
      throw new Error(
        `scene surfaces section byte length ${expectedByteLength} is invalid`,
      );
    }
    if (bindings.surfaces.byteLength !== expectedByteLength) {
      throw new Error(
        `scene surfaces binding byteLength ${bindings.surfaces.byteLength} != expected ${expectedByteLength}`,
      );
    }
    // The WGSL layout has a one-record minimum even for an empty logical
    // section; SceneUploader allocates the same ABI floor.
    const required = Math.max(expectedByteLength, SURFACE_STRIDE);
    if (bindings.surfaces.buffer.size < required) {
      throw new Error(
        `scene surfaces buffer size ${bindings.surfaces.buffer.size} < required ${required}`,
      );
    }
  }

  private assertExtent(
    header: { renderWidth: number; renderHeight: number; dpr: number },
    sceneBytes: Uint8Array,
    input: ShadowPassInput,
  ): void {
    if (!Number.isInteger(header.renderWidth) || header.renderWidth <= 0) {
      throw new Error(`renderWidth must be a positive integer, got ${header.renderWidth}`);
    }
    if (!Number.isInteger(header.renderHeight) || header.renderHeight <= 0) {
      throw new Error(`renderHeight must be a positive integer, got ${header.renderHeight}`);
    }
    const texelCount = header.renderWidth * header.renderHeight;
    if (!Number.isSafeInteger(texelCount) || texelCount > U32_MAX) {
      throw new Error(
        `render texel count ${header.renderWidth}x${header.renderHeight} exceeds ` +
          `u32 (${U32_MAX}) or safe integers`,
      );
    }
    const provenance = input.height.provenance;
    if (
      input.casterHeight.provenance !== provenance ||
      input.objectId.provenance !== provenance
    ) {
      throw new Error(
        "mixed HeightPass provenance: height, casterHeight and objectId must come " +
          "from one successful HeightPass dispatch",
      );
    }
    if (provenance.sceneBytes !== sceneBytes) {
      throw new Error(
        "height field provenance does not match the dispatched scene: consume a complete " +
          "HeightPass snapshot produced from this exact EncodedScene",
      );
    }
    if (
      provenance.width !== header.renderWidth ||
      provenance.height !== header.renderHeight ||
      provenance.dpr !== header.dpr
    ) {
      throw new Error(
        `HeightPass provenance extent ${provenance.width}x${provenance.height} at dpr ` +
          `${provenance.dpr} != render extent ${header.renderWidth}x${header.renderHeight} ` +
          `at dpr ${header.dpr}`,
      );
    }
    for (const [name, binding] of [
      ["height", input.height],
      ["casterHeight", input.casterHeight],
      ["objectId", input.objectId],
    ] as const) {
      if (binding.width !== header.renderWidth || binding.height !== header.renderHeight) {
        throw new Error(
          `${name} binding extent ${binding.width}x${binding.height} != render extent ` +
            `${header.renderWidth}x${header.renderHeight}`,
        );
      }
      const expectedBytes = texelCount * 4;
      if (binding.byteLength !== expectedBytes) {
        throw new Error(
          `${name} binding byteLength ${binding.byteLength} != expected ${expectedBytes} ` +
            `(${header.renderWidth}x${header.renderHeight} field)`,
        );
      }
      const expectedFormat = name === "objectId" ? "u32" : "f32";
      if (binding.format !== expectedFormat) {
        throw new Error(
          `${name} binding format ${String(binding.format)} != ${expectedFormat}`,
        );
      }
      if ((binding.usage & GPU_USAGE_STORAGE) === 0) {
        throw new Error(
          `${name} binding usage 0x${binding.usage.toString(16)} lacks STORAGE`,
        );
      }
      const required = Math.max(expectedBytes, MIN_PASS_ALLOCATION_BYTES);
      if (binding.buffer.size < required) {
        throw new Error(
          `${name} buffer size ${binding.buffer.size} < required ${required} ` +
            `(${header.renderWidth}x${header.renderHeight} field)`,
        );
      }
    }
  }

  private assertDeviceLimits(workgroupCountX: number): void {
    const limits = this.device.limits;
    const maxWorkgroupX = positiveLimit(limits.maxComputeWorkgroupSizeX, 256);
    const maxInvocations = positiveLimit(limits.maxComputeInvocationsPerWorkgroup, 256);
    if (SHADOW_WORKGROUP_SIZE > maxWorkgroupX || SHADOW_WORKGROUP_SIZE > maxInvocations) {
      throw new Error(
        `workgroup size ${SHADOW_WORKGROUP_SIZE} exceeds device limits ` +
          `(maxComputeWorkgroupSizeX ${maxWorkgroupX}, ` +
          `maxComputeInvocationsPerWorkgroup ${maxInvocations})`,
      );
    }
    const maxWorkgroups = positiveLimit(limits.maxComputeWorkgroupsPerDimension, DEFAULT_MAX_WORKGROUPS);
    if (workgroupCountX > maxWorkgroups) {
      throw new Error(
        `dispatch count ${workgroupCountX} exceeds maxComputeWorkgroupsPerDimension ${maxWorkgroups}`,
      );
    }
  }

  private assertAllocationWithinLimits(byteLength: number, label: string): void {
    const limits = this.device.limits;
    const maxStorage = positiveLimit(limits.maxStorageBufferBindingSize, DEFAULT_MAX_STORAGE_BYTES);
    const maxBuffer = positiveLimit(limits.maxBufferSize, DEFAULT_MAX_STORAGE_BYTES);
    const bound = Math.min(maxStorage, maxBuffer);
    if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > bound) {
      throw new Error(
        `${label} allocation of ${byteLength} bytes exceeds device limits ` +
          `(maxStorageBufferBindingSize ${maxStorage}, maxBufferSize ${maxBuffer})`,
      );
    }
  }

  /** Validate every exact range later supplied in `GPUBufferBinding.size`. */
  private assertStorageBindingsWithinLimit(
    bindings: ReadonlyArray<readonly [label: string, byteLength: number]>,
  ): void {
    const maxStorage = positiveLimit(
      this.device.limits.maxStorageBufferBindingSize,
      DEFAULT_MAX_STORAGE_BYTES,
    );
    const invalid = bindings.filter(([, byteLength]) =>
      !Number.isSafeInteger(byteLength) || byteLength <= 0 || byteLength > maxStorage,
    );
    if (invalid.length > 0) {
      throw new Error(
        `storage binding ranges exceed maxStorageBufferBindingSize ${maxStorage}: ` +
          invalid.map(([label, byteLength]) => `${label} ${byteLength} bytes`).join(", "),
      );
    }
  }

  /**
   * Derive the conservative caster bound from the CPU-resident, strictly
   * validated ABI surface records (never a GPU scan): `maxCasterHeight =
   * max(f32(elevation) + f32(thickness))` over casting surfaces, summed in
   * f64 and f32-rounded so the uniform equals the shader's f32 flat-top
   * value. `hasCasters` drives the shader's no-caster early exit.
   */
  private readCasterInfo(
    bytes: Uint8Array,
    header: { surfaceCount: number },
  ): CasterInfo {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let hasCasters = false;
    let casterSurfaceCount = 0;
    let maxCasterHeight = 0;
    for (let i = 0; i < header.surfaceCount; i++) {
      const record = HEADER_SIZE + i * SURFACE_STRIDE;
      const flags = view.getUint32(record + SURFACE_OFFSET_FLAGS, true);
      if ((flags & FLAG_CASTS_SHADOW) === 0) {
        continue;
      }
      hasCasters = true;
      casterSurfaceCount += 1;
      const elevation = view.getFloat32(record + SURFACE_OFFSET_ELEVATION, true);
      const thickness = view.getFloat32(record + SURFACE_OFFSET_THICKNESS, true);
      maxCasterHeight = Math.max(maxCasterHeight, Math.fround(elevation + thickness));
    }
    return { hasCasters, casterSurfaceCount, maxCasterHeight };
  }

  // -- allocations ----------------------------------------------------------

  private ensureAllocation(
    name: ShadowAllocationName,
    byteLength: number,
    usage: number,
  ): GpuBufferLike {
    const required = Math.max(byteLength, MIN_PASS_ALLOCATION_BYTES);
    const current = this.allocations.get(name);
    if (current !== undefined && current.size >= required) {
      return current;
    }
    if (current !== undefined) {
      current.destroy();
    }
    const created = this.device.createBuffer({ size: required, usage, label: `ukibori-${name}` });
    this.allocations.set(name, created);
    this.allocationSizes.set(name, created.size);
    this.newAllocations += 1;
    return created;
  }

  private allocation(name: ShadowAllocationName): GpuBufferLike {
    const buffer = this.allocations.get(name);
    if (buffer === undefined) {
      throw new Error(`missing allocation for ${name}`);
    }
    return buffer;
  }

  // -- host packing (little-endian, offsets pinned by shadow-pass-wgsl.ts) --

  private packUniform(
    header: { dpr: number; surfaceCount: number; renderWidth: number; renderHeight: number },
    parsed: ReturnType<typeof parseHeader>,
    options: ShadowEffectiveOptions,
    stepCount: number,
    caster: CasterInfo,
    yOffset: number,
    regionEnd: number,
  ): void {
    const view = new DataView(this.uniformBytes.buffer);
    view.setFloat32(0, header.dpr, true);
    view.setFloat32(4, 0, true);
    view.setFloat32(8, 0, true);
    view.setFloat32(12, 0, true);
    view.setFloat32(16, parsed.lightDirection.x, true);
    view.setFloat32(20, parsed.lightDirection.y, true);
    view.setFloat32(24, parsed.lightDirection.z, true);
    view.setFloat32(28, 0, true);
    view.setFloat32(32, options.stepSize, true);
    view.setFloat32(36, options.bias, true);
    view.setFloat32(40, options.maxDistance, true);
    view.setFloat32(44, caster.maxCasterHeight, true);
    view.setUint32(48, header.renderWidth, true);
    view.setUint32(52, header.renderHeight, true);
    view.setUint32(56, SHADOW_WORKGROUP_SIZE, true);
    view.setUint32(60, header.surfaceCount, true);
    view.setUint32(64, stepCount, true);
    view.setUint32(68, caster.hasCasters ? 1 : 0, true);
    view.setUint32(72, yOffset, true);
    view.setUint32(76, regionEnd, true);
  }

  // -- pipeline and bind group ----------------------------------------------

  private ensurePipeline(): CachedShadowPipeline {
    if (this.cached !== null) {
      return this.cached;
    }
    // Explicit layouts only (never layout: "auto"). Storage count per
    // stage: 5 read-only + 1 output = 6, below the spec-minimum 8.
    const layout = this.device.createBindGroupLayout({
      label: "ukibori-shadow-pass",
      entries: [
        {
          binding: 0,
          visibility: COMPUTE_STAGE_VISIBILITY,
          buffer: {
            type: "uniform",
            hasDynamicOffset: false,
            minBindingSize: SHADOW_PARAMS_BYTE_LENGTH,
          },
        },
        {
          binding: 1,
          visibility: COMPUTE_STAGE_VISIBILITY,
          buffer: {
            type: "read-only-storage",
            hasDynamicOffset: false,
            minBindingSize: 4, // at least one f32 height texel
          },
        },
        {
          binding: 2,
          visibility: COMPUTE_STAGE_VISIBILITY,
          buffer: {
            type: "read-only-storage",
            hasDynamicOffset: false,
            minBindingSize: 4, // at least one f32 caster texel
          },
        },
        {
          binding: 3,
          visibility: COMPUTE_STAGE_VISIBILITY,
          buffer: {
            type: "read-only-storage",
            hasDynamicOffset: false,
            minBindingSize: 4, // at least one u32 object-id texel
          },
        },
        {
          binding: 4,
          visibility: COMPUTE_STAGE_VISIBILITY,
          buffer: {
            type: "read-only-storage",
            hasDynamicOffset: false,
            minBindingSize: SURFACE_STRIDE, // at least one SurfaceRecord
          },
        },
        {
          binding: 5,
          visibility: COMPUTE_STAGE_VISIBILITY,
          buffer: {
            type: "storage",
            hasDynamicOffset: false,
            minBindingSize: SHADOW_OUTPUT_BYTES_PER_TEXEL, // one f32 scalar
          },
        },
      ],
    });
    const module = this.device.createShaderModule({
      code: SHADOW_PASS_WGSL,
      label: "ukibori-shadow-pass",
    });
    const pipelineLayout = this.device.createPipelineLayout({
      label: "ukibori-shadow-pass",
      bindGroupLayouts: [layout],
    });
    const pipeline = this.device.createComputePipeline({
      label: "ukibori-shadow-pass",
      layout: pipelineLayout,
      compute: { module, entryPoint: "main" },
    });
    this.cached = { layout, pipelineLayout, pipeline, module };
    return this.cached;
  }
}

// -- helpers ----------------------------------------------------------------

function shadowStepCount(maxDistance: number, stepSize: number): number {
  const quotient = maxDistance / stepSize;
  if (!Number.isFinite(quotient) || quotient <= 0) {
    return MAX_SHADOW_STEP_COUNT + 1;
  }
  const count = Math.floor(quotient);
  return Number.isSafeInteger(count) ? count : MAX_SHADOW_STEP_COUNT + 1;
}

function sanitizeF32StrictPositive(v: number | undefined, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return fallback;
  }
  const rounded = Math.fround(v);
  if (!Number.isFinite(rounded) || rounded <= 0) {
    return fallback;
  }
  return rounded;
}

function sanitizeF32NonNegative(v: number | undefined, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return fallback;
  }
  const rounded = Math.fround(v);
  if (!Number.isFinite(rounded) || rounded < 0) {
    return fallback;
  }
  return rounded;
}

function sumOf(sizes: Map<string, number>): number {
  let total = 0;
  for (const size of sizes.values()) {
    total += size;
  }
  return total;
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

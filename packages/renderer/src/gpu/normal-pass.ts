import type { NormalOptions } from "../lighting";
import {
  COMPUTE_STAGE_VISIBILITY,
  GPU_USAGE_UNIFORM,
} from "./height-pass";
import type {
  GpuBindGroupLayoutLike,
  GpuBindGroupLike,
  GpuComputeDeviceLike,
  GpuComputePipelineLike,
  GpuPipelineLayoutLike,
  GpuShaderModuleLike,
  HeightPassProvenance,
  HeightPassSnapshot,
} from "./height-pass";
import { GPU_USAGE_COPY_DST, GPU_USAGE_COPY_SRC, GPU_USAGE_STORAGE } from "./layout";
import type { GpuBufferLike } from "./uploader";
import type { BandRegion } from "./tiles";
import { assertBandRegion } from "./tiles";
import type { GpuTimestampWritesLike } from "./timestamp-profiler";
import {
  NORMAL_OUTPUT_BYTES_PER_TEXEL,
  NORMAL_PARAMS_BYTE_LENGTH,
  NORMAL_PASS_WGSL,
  NORMAL_WORKGROUP_SIZE,
} from "./normal-pass-wgsl";

/**
 * #26 GPU normal field stage — a real WebGPU compute pass that consumes the
 * #25 `HeightPass` height allocation DIRECTLY and writes a GPU-resident
 * normalized normal field for the same render extent.
 *
 * ## Direct #25 height binding
 *
 * `dispatch()` takes a narrow `NormalHeightBinding` whose `buffer` is the
 * exact `HeightPass.getSnapshot().outputs.height.buffer` (built with
 * `normalHeightBindingFromHeightPass`), never a copy into a new input
 * allocation. The five scene buffers, coverage, objectId and materialId are
 * not required by the normal algorithm and are never bound.
 *
 * ## Fixed CPU semantic contract (mirrors `computeNormals` exactly)
 *
 * - symmetric central difference; at target edges the missing neighbor is
 *   replicated/clamped to the edge texel (no wrap, no out-of-buffer sample,
 *   no smoothing kernel)
 * - coordinates +x right, +y down, +z toward the viewer; a height rising
 *   toward +x produces a negative normal x component (same sign rule for +y)
 * - scaling affects only the derivative-to-normal conversion (defaults
 *   `scaleX = scaleY = 0.5`, `normalScale = 1`); finite custom x/y scales
 *   are allowed including zero or negative values; `normalScale` must be
 *   finite and strictly positive or fall back to 1
 * - no owner/coverage gating: a background texel adjacent to a height
 *   discontinuity tilts exactly like the CPU oracle (no flattening shortcut)
 * - overflow-safe max-component-first normalization keeps every output
 *   vector finite and unit length; flat input is `(0, 0, 1)`
 *
 * ## Option sanitization policy (documented and pinned by tests)
 *
 * `sanitizeNormalOptions` maps each option to a finite f32 value. Every
 * option is judged AFTER f32 rounding (`Math.fround`): the value actually
 * packed to the GPU must be finite, and `normalScale` must additionally be
 * strictly positive, otherwise the default is used:
 *
 * - non-finite raw values (NaN, +/-Infinity) fall back to the default
 *   (`scaleX/scaleY` 0.5, `normalScale` 1)
 * - raw finite values that round to a non-finite f32 (anything above the
 *   f32 rounding boundary `F32_MAX + 2^103`, e.g. `1e300`) fall back: they
 *   cannot be packed into a finite f32, and parity is only defined for
 *   representable f32 options
 * - a raw positive `normalScale` that rounds to zero (`v < 2^-150`, e.g.
 *   `5e-324`) falls back because the packed value must stay strictly
 *   positive; x/y scales may intentionally round to or equal zero
 * - representable finite values are rounded to f32 (`Math.fround`) and
 *   packed into the uniform little-endian
 *
 * ## Validation before ANY device call
 *
 * `dispatch()` rejects, in order and before any allocation/write/pipeline/
 * bind-group/encoder call:
 *
 * 1. non-positive / non-integer width or height
 * 2. a render texel count above u32 or unsafe integers
 * 3. a height binding whose byteLength != `width * height * 4`
 * 4. a height binding whose format is not `f32`
 * 5. a height binding whose usage lacks STORAGE
 * 6. a height buffer whose size is below the required logical bytes
 * 7. workgroup-size limits (`maxComputeWorkgroupSizeX`,
 *    `maxComputeInvocationsPerWorkgroup`) and dispatch-count limits
 *    (`maxComputeWorkgroupsPerDimension`)
 * 8. allocation bytes beyond `maxStorageBufferBindingSize` / `maxBufferSize`
 *
 * ## Output
 *
 * One tightly packed row-major f32 xyz triple per texel
 * (`NORMAL_OUTPUT_BYTES_PER_TEXEL = 12` logical bytes per texel, no
 * vec3/16-byte stride). The production allocation is
 * `STORAGE | COPY_SRC | COPY_DST`, never mapped, and exposed through the
 * stable read-only snapshot for later lighting. Normal-frame execution
 * performs only a uniform upload and a compute submission — no map, no
 * readback.
 *
 * ## Structural device interface
 *
 * The class drives the same narrow structural `GpuComputeDeviceLike` mirror
 * as `HeightPass` (the real `GPUDevice` cast is the only boundary; the Node
 * test mock implements the same surface, so no fabricated WebGPU methods
 * exist).
 */
export const NORMAL_PASS_OUTPUT_USAGE =
  GPU_USAGE_STORAGE | GPU_USAGE_COPY_SRC | GPU_USAGE_COPY_DST;

/** Largest u32 value; the texel count packed into the uniform must fit it. */
const U32_MAX = 0xffffffff;

/** Default `maxStorageBufferBindingSize` / `maxBufferSize` (spec minimum). */
const DEFAULT_MAX_STORAGE_BYTES = 256 * 1024 * 1024;

/** Default `maxComputeWorkgroupsPerDimension` (spec minimum). */
const DEFAULT_MAX_WORKGROUPS = 65535;

/** Smallest legal allocation for pass-owned buffers. */
const MIN_PASS_ALLOCATION_BYTES = 16;

/** Host binding view of the #25 height output (narrow structural type). */
export interface NormalHeightBinding {
  /** the EXACT #25 height output buffer (never a copy) */
  readonly buffer: GpuBufferLike;
  /** logical field bytes (== width * height * 4) */
  readonly byteLength: number;
  /** the #25 height output format; only f32 is accepted */
  readonly format: "f32";
  /** must include STORAGE (the shader reads the buffer as storage) */
  readonly usage: number;
  /** render extent width (texels) */
  readonly width: number;
  /** render extent height (texels) */
  readonly height: number;
  /**
   * O(1) identity of the successful #25 dispatch this height field came
   * from (#28 provenance propagation). Set automatically by
   * `normalHeightBindingFromHeightPass`; optional so synthetic height
   * inputs (which have no HeightPass execution) stay legal.
   */
  readonly provenance?: HeightPassProvenance;
}

/** Effective (sanitized + f32-rounded) normal options actually dispatched. */
export interface NormalEffectiveOptions {
  readonly scaleX: number;
  readonly scaleY: number;
  readonly normalScale: number;
}

export interface NormalPassInput {
  /** the #25 height binding consumed DIRECTLY (never copied) */
  readonly height: NormalHeightBinding;
  /** CPU-compatible normal options; sanitized like the oracle */
  readonly options?: NormalOptions;
  /**
   * #32 optional dispatch region (inclusive texel rows): only those rows
   * are computed (`ceil(bandTexels / NORMAL_WORKGROUP_SIZE)` workgroups;
   * the in-shader index adds `y0 * width`), so texels outside the band are
   * never written. Bounds-safe by construction; `undefined` keeps the
   * historical full-frame dispatch.
   */
  readonly region?: BandRegion;
  /** Optional real GPU timestamp-query writes for this compute pass. */
  readonly timestampWrites?: GpuTimestampWritesLike;
}

/** Stable read-only output binding for later lighting (#27+). */
export interface NormalOutputBinding {
  /** GPU allocation (never undefined after the first dispatch) */
  readonly buffer: GpuBufferLike;
  /** logical bytes == 12 * width * height (tightly packed xyz triples) */
  readonly byteLength: number;
  readonly format: "f32";
  /** one tightly packed f32 xyz triple per texel */
  readonly channels: 3;
  /** `STORAGE | COPY_SRC | COPY_DST` */
  readonly usage: number;
}

export interface NormalPassLastDispatch {
  readonly renderWidth: number;
  readonly renderHeight: number;
  /** ceil(texels / NORMAL_WORKGROUP_SIZE) */
  readonly workgroupCountX: number;
}

/** Stable read-only snapshot of the normal field after the last dispatch. */
export interface NormalPassSnapshot {
  readonly width: number;
  readonly height: number;
  readonly workgroupSize: number;
  readonly output: NormalOutputBinding;
  /** the effective (sanitized, f32-rounded) options that ran */
  readonly options: NormalEffectiveOptions;
  readonly lastDispatch: NormalPassLastDispatch;
  /**
   * The per-HeightPass-dispatch provenance propagated from the #25 height
   * binding (null for synthetic height inputs that carry none). #28
   * lighting consumes this to reject foreign/mixed lighting fields.
   */
  readonly provenance: HeightPassProvenance | null;
}

export interface NormalPassDispatchStats {
  readonly newAllocations: number;
  readonly allocationCount: number;
  readonly totalAllocationBytes: number;
  readonly workgroupCountX: number;
}

/**
 * Sanitize `NormalOptions` to the effective values packed to the GPU (see
 * class docs for the policy). Defaults stay CPU-compatible: `scaleX = 0.5`,
 * `scaleY = 0.5`, `normalScale = 1` (all f32-exact).
 *
 * Every option is judged AFTER f32 rounding (`Math.fround`): the rounded
 * value must be finite, and `normalScale` must additionally be strictly
 * positive (`fround(5e-324) === 0` falls back to 1). Values that round to
 * a non-finite f32 (above `F32_MAX + 2^103`, the f32 rounding boundary)
 * also fall back.
 */
export function sanitizeNormalOptions(options: NormalOptions = {}): NormalEffectiveOptions {
  const finiteScale = (v: number | undefined, fallback: number): number => {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      return fallback;
    }
    const rounded = Math.fround(v);
    if (!Number.isFinite(rounded)) {
      return fallback;
    }
    return rounded;
  };
  const strictPositive = (v: number | undefined, fallback: number): number => {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      return fallback;
    }
    const rounded = Math.fround(v);
    if (!Number.isFinite(rounded) || rounded <= 0) {
      return fallback;
    }
    return rounded;
  };
  return {
    scaleX: finiteScale(options.scaleX, 0.5),
    scaleY: finiteScale(options.scaleY, 0.5),
    normalScale: strictPositive(options.normalScale, 1),
  };
}

/**
 * Build the narrow `NormalHeightBinding` consumed by `NormalPass` from the
 * #25 output snapshot — the exact `outputs.height` buffer and the snapshot
 * render extent.
 */
export function normalHeightBindingFromHeightPass(
  snapshot: HeightPassSnapshot,
): NormalHeightBinding {
  const height = snapshot.outputs.height;
  return {
    buffer: height.buffer,
    byteLength: height.byteLength,
    // the #25 height output is always f32 by construction; the narrow cast
    // here is the same structural boundary used for GpuBufferLike/GPUBuffer
    format: height.format as "f32",
    usage: height.usage,
    width: snapshot.width,
    height: snapshot.height,
    // #28 provenance propagation: the lighting stage needs the exact
    // per-HeightPass-dispatch token shared by every integrated field.
    provenance: snapshot.provenance,
  };
}

type NormalAllocationName = "uniform" | "outNormal";

interface CachedNormalPipeline {
  layout: GpuBindGroupLayoutLike;
  pipelineLayout: GpuPipelineLayoutLike;
  pipeline: GpuComputePipelineLike;
  module: GpuShaderModuleLike;
}

export class NormalPass {
  private readonly allocations = new Map<NormalAllocationName, GpuBufferLike>();
  private readonly allocationSizes = new Map<NormalAllocationName, number>();
  private readonly uniformBytes = new Uint8Array(NORMAL_PARAMS_BYTE_LENGTH);
  private newAllocations = 0;
  private lastDispatch: NormalPassLastDispatch | null = null;
  private lastOptions: NormalEffectiveOptions | null = null;
  private lastProvenance: HeightPassProvenance | null = null;
  private cached: CachedNormalPipeline | null = null;

  constructor(private readonly device: GpuComputeDeviceLike) {}

  /**
   * Compute the normal field for one #25 height binding. Validation,
   * limits and allocation bounds all run BEFORE any device call; execution
   * then performs only a uniform upload and one compute submission (no map,
   * no readback). Updating options reuses the same height/output
   * allocations: it only re-packs the bounded uniform and reruns the pass.
   */
  dispatch(input: NormalPassInput): NormalPassDispatchStats {
    const height = input.height;
    this.assertHeightBinding(height);
    const options = sanitizeNormalOptions(input.options);
    const texelCount = height.width * height.height;
    // #32 region dispatch: only the band rows are dispatched; the guard in
    // the shader still uses the full texel count so the band stays in bounds.
    const region = assertBandRegion(input.region, height.height);
    const bandRows = region === null ? height.height : region.y1 - region.y0 + 1;
    const bandTexels = height.width * bandRows;
    const yOffset = region === null ? 0 : region.y0 * height.width;
    const regionEnd = region === null ? 0 : yOffset + bandTexels;
    const workgroupCountX = Math.ceil(bandTexels / NORMAL_WORKGROUP_SIZE);
    this.assertDeviceLimits(workgroupCountX);
    const outputBytes = texelCount * NORMAL_OUTPUT_BYTES_PER_TEXEL;
    this.assertAllocationWithinLimits(NORMAL_PARAMS_BYTE_LENGTH, "params uniform");
    this.assertAllocationWithinLimits(outputBytes, "normal output");

    this.ensureAllocation(
      "uniform",
      NORMAL_PARAMS_BYTE_LENGTH,
      GPU_USAGE_UNIFORM | GPU_USAGE_COPY_DST,
    );
    this.ensureAllocation("outNormal", outputBytes, NORMAL_PASS_OUTPUT_USAGE);
    this.packUniform(height.width, height.height, options, yOffset, regionEnd);
    const uniform = this.allocation("uniform");
    this.device.queue.writeBuffer(uniform, 0, this.uniformBytes);

    const cached = this.ensurePipeline();
    const group = this.device.createBindGroup({
      label: "ukibori-normal-pass",
      layout: cached.layout,
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        // The #25 height output is consumed DIRECTLY (narrow structural
        // cast at this boundary, never a copy into a new input allocation).
        { binding: 1, resource: { buffer: height.buffer } },
        { binding: 2, resource: { buffer: this.allocation("outNormal") } },
      ],
    });

    const encoder = this.device.createCommandEncoder({ label: "ukibori-normal-pass" });
    const pass = encoder.beginComputePass(
      input.timestampWrites === undefined
        ? undefined
        : { timestampWrites: input.timestampWrites },
    );
    pass.setPipeline(cached.pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(workgroupCountX);
    pass.end();
    this.device.queue.submit([encoder.finish()]);

    this.lastDispatch = {
      renderWidth: height.width,
      renderHeight: height.height,
      workgroupCountX,
    };
    this.lastOptions = options;
    this.lastProvenance = height.provenance ?? null;

    const stats: NormalPassDispatchStats = {
      newAllocations: this.newAllocations,
      allocationCount: this.allocations.size,
      totalAllocationBytes: sumOf(this.allocationSizes),
      workgroupCountX,
    };
    this.newAllocations = 0;
    return stats;
  }

  /** Stable read-only snapshot; throws before the first successful dispatch. */
  getSnapshot(): NormalPassSnapshot {
    if (this.lastDispatch === null || this.lastOptions === null) {
      throw new Error("no dispatch: dispatch() has not completed or dispose() was called");
    }
    const texelCount = this.lastDispatch.renderWidth * this.lastDispatch.renderHeight;
    return {
      width: this.lastDispatch.renderWidth,
      height: this.lastDispatch.renderHeight,
      workgroupSize: NORMAL_WORKGROUP_SIZE,
      output: {
        buffer: this.allocation("outNormal"),
        byteLength: texelCount * NORMAL_OUTPUT_BYTES_PER_TEXEL,
        format: "f32",
        channels: 3,
        usage: NORMAL_PASS_OUTPUT_USAGE,
      },
      options: this.lastOptions,
      lastDispatch: this.lastDispatch,
      provenance: this.lastProvenance,
    };
  }

  /** Destroy every owned GPU allocation (never foreign height buffers). Idempotent. */
  dispose(): void {
    for (const buffer of this.allocations.values()) {
      buffer.destroy();
    }
    this.allocations.clear();
    this.allocationSizes.clear();
    this.newAllocations = 0;
    this.lastDispatch = null;
    this.lastOptions = null;
    this.lastProvenance = null;
  }

  // -- validation (all BEFORE any device call) ------------------------------

  private assertHeightBinding(height: NormalHeightBinding): void {
    if (!Number.isInteger(height.width) || height.width <= 0) {
      throw new Error(`height width must be a positive integer, got ${height.width}`);
    }
    if (!Number.isInteger(height.height) || height.height <= 0) {
      throw new Error(`height height must be a positive integer, got ${height.height}`);
    }
    // the texel count is packed into the uniform as u32 AND used by the
    // in-shader u32 texel-count product; it must fit u32 and safe integers
    const texelCount = height.width * height.height;
    if (!Number.isSafeInteger(texelCount) || texelCount > U32_MAX) {
      throw new Error(
        `render texel count ${height.width}x${height.height} exceeds ` +
          `u32 (${U32_MAX}) or safe integers`,
      );
    }
    const expectedBytes = texelCount * 4;
    if (height.byteLength !== expectedBytes) {
      throw new Error(
        `height binding byteLength ${height.byteLength} != expected ${expectedBytes} ` +
          `(${height.width}x${height.height} f32 field)`,
      );
    }
    if (height.format !== "f32") {
      throw new Error(`height binding format ${String(height.format)} != f32`);
    }
    if ((height.usage & GPU_USAGE_STORAGE) === 0) {
      throw new Error(`height binding usage 0x${height.usage.toString(16)} lacks STORAGE`);
    }
    const required = Math.max(expectedBytes, MIN_PASS_ALLOCATION_BYTES);
    if (height.buffer.size < required) {
      throw new Error(
        `height buffer size ${height.buffer.size} < required ${required} ` +
          `(${height.width}x${height.height} f32 field)`,
      );
    }
  }

  private assertDeviceLimits(workgroupCountX: number): void {
    const limits = this.device.limits;
    const maxWorkgroupX = positiveLimit(limits.maxComputeWorkgroupSizeX, 256);
    const maxInvocations = positiveLimit(limits.maxComputeInvocationsPerWorkgroup, 256);
    if (NORMAL_WORKGROUP_SIZE > maxWorkgroupX || NORMAL_WORKGROUP_SIZE > maxInvocations) {
      throw new Error(
        `workgroup size ${NORMAL_WORKGROUP_SIZE} exceeds device limits ` +
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

  // -- allocations ----------------------------------------------------------

  private ensureAllocation(
    name: NormalAllocationName,
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

  private allocation(name: NormalAllocationName): GpuBufferLike {
    const buffer = this.allocations.get(name);
    if (buffer === undefined) {
      throw new Error(`missing allocation for ${name}`);
    }
    return buffer;
  }

  // -- host packing (little-endian, offsets pinned by normal-pass-wgsl.ts) --

  private packUniform(
    width: number,
    height: number,
    options: NormalEffectiveOptions,
    yOffset: number,
    regionEnd: number,
  ): void {
    const view = new DataView(this.uniformBytes.buffer);
    view.setFloat32(0, options.scaleX, true);
    view.setFloat32(4, options.scaleY, true);
    view.setFloat32(8, options.normalScale, true);
    view.setUint32(12, width, true);
    view.setUint32(16, height, true);
    view.setUint32(20, NORMAL_WORKGROUP_SIZE, true);
    view.setUint32(24, yOffset, true);
    view.setUint32(28, regionEnd, true);
  }

  // -- pipeline and bind group ----------------------------------------------

  private ensurePipeline(): CachedNormalPipeline {
    if (this.cached !== null) {
      return this.cached;
    }
    // Explicit layouts only (never layout: "auto"). Storage count per
    // stage: 2 (inHeight + outNormal), far below the spec-minimum 8.
    const layout = this.device.createBindGroupLayout({
      label: "ukibori-normal-pass",
      entries: [
        {
          binding: 0,
          visibility: COMPUTE_STAGE_VISIBILITY,
          buffer: {
            type: "uniform",
            hasDynamicOffset: false,
            minBindingSize: NORMAL_PARAMS_BYTE_LENGTH,
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
            type: "storage",
            hasDynamicOffset: false,
            minBindingSize: NORMAL_OUTPUT_BYTES_PER_TEXEL, // one xyz triple
          },
        },
      ],
    });
    const module = this.device.createShaderModule({
      code: NORMAL_PASS_WGSL,
      label: "ukibori-normal-pass",
    });
    const pipelineLayout = this.device.createPipelineLayout({
      label: "ukibori-normal-pass",
      bindGroupLayouts: [layout],
    });
    const pipeline = this.device.createComputePipeline({
      label: "ukibori-normal-pass",
      layout: pipelineLayout,
      compute: { module, entryPoint: "main" },
    });
    this.cached = { layout, pipelineLayout, pipeline, module };
    return this.cached;
  }
}

// -- helpers ----------------------------------------------------------------

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

import {
  GPU_USAGE_COPY_DST,
  GPU_USAGE_COPY_SRC,
  GPU_USAGE_STORAGE,
} from "./layout";
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
} from "./height-pass";
import type { BandRegion } from "./tiles";
import { assertBandRegion, planDispatchChunks } from "./tiles";
import type { GpuTimestampWritesLike } from "./timestamp-profiler";
import type { GpuBufferLike } from "./uploader";
import type { ShadowFieldBinding } from "./shadow-pass";
import type { LightingFieldBinding } from "./lighting-pass";
import type { PresentationInputBinding } from "./presentation-pass";
import {
  sanitizeReconstructionOptions,
  RECONSTRUCTION_VALUE_SIGMA,
} from "../shadow-reconstruct";
import type { ShadowReconstructionOptions } from "../shadow-reconstruct";
import {
  RECONSTRUCTION_MODE_HARD,
  RECONSTRUCTION_MODE_SOFT,
  RECONSTRUCTION_OUTPUT_BYTES_PER_TEXEL,
  RECONSTRUCTION_PARAMS_BYTE_LENGTH,
  RECONSTRUCTION_PASS_WGSL,
  RECONSTRUCTION_WORKGROUP_SIZE,
} from "./reconstruction-pass-wgsl";

/**
 * #43/#53 GPU shadow-visibility reconstruction stage — a retained compute
 * pass between the #41 ShadowPass and the LightingPass with TWO kernels
 * (see `reconstruction-pass-wgsl.ts` for the fixed semantics; the oracles
 * are `shadow-reconstruct.ts`):
 *
 * - mode 0 (SOFT, default): turns the decorrelated RAW area-light visibility
 *   field into a smooth penumbra through the #43 value-bilateral box filter
 *   (a Gaussian weight in VISIBILITY value keeps narrow bands and edges —
 *   replacing the plain gated box average did not change the soft path's
 *   radius, sample or scheduling semantics);
 * - mode 1 (HARD): the #53 ring-rule binomial edge refinement of the BINARY
 *   {0,1} raw hard field (a 1-texel display antialiasing ramp, bit-exact
 *   dyadic k/16 values; raw bytes keep the historical contract).
 *
 * The pipeline selects the mode from the shadow path (soft vs hard); the
 * pass itself never inspects the shadow options.
 *
 * ## Inputs bound DIRECTLY (never copied)
 *
 * - the EXACT ShadowPass output (`rawVisibility`) — consumed read-only;
 * - the EXACT HeightPass full-height and object-id outputs (edge guidance);
 * all three must share one per-dispatch HeightPass provenance token, so
 * foreign or mixed fields are rejected before any device call.
 *
 * No scene bytes are consumed: the filter is a pure function of the three
 * retained fields plus the sanitized options.
 *
 * ## Retained resources / option updates
 *
 * Like every field pass, pipelines/bind groups/buffers are retained across
 * frames: an option-only update rewrites the bounded uniform and
 * redispatches; identical inputs perform no allocation.
 *
 * ## Region dispatch (#32/#43 halo)
 *
 * The dispatched band is provided by the caller —the pipeline expands the
 * shared band by the mode's halo (soft: the sanitized texel radius; hard: 1
 * texel for the 3x3 ring) on each side (clipped to the frame), because the
 * filter reads raw visibility of neighbors while every CONSUMED output row
 * (the lighting band) must be written this frame. Out-of-band reads hit
 * retained raw texels that the #32 planner's shadow halo proves unchanged;
 * the shader never reads its own output, so no cross-band feedback exists.
 */

export const RECONSTRUCTION_PASS_OUTPUT_USAGE =
  GPU_USAGE_STORAGE | GPU_USAGE_COPY_SRC | GPU_USAGE_COPY_DST;

/** Largest u32 value; the texel count packed into the uniform must fit it. */
const U32_MAX = 0xffffffff;

/** Default `maxStorageBufferBindingSize` / `maxBufferSize` (spec minimum). */
const DEFAULT_MAX_STORAGE_BYTES = 256 * 1024 * 1024;

/** Default `maxComputeWorkgroupsPerDimension` (spec minimum). */
const DEFAULT_MAX_WORKGROUPS = 65535;

/** Smallest legal allocation for pass-owned buffers. */
const MIN_PASS_ALLOCATION_BYTES = 16;

export interface ReconstructionPassInput {
  /** the EXACT #41 raw visibility output (ShadowPass snapshot binding) */
  readonly rawVisibility: ShadowFieldBinding;
  /** the EXACT #25 full height binding (edge-guidance input) */
  readonly height: ShadowFieldBinding;
  /** the EXACT #25 object-id binding (ownership edge gate) */
  readonly objectId: ShadowFieldBinding;
  /** raw reconstruction options; sanitized exactly like the CPU oracle */
  readonly options?: ShadowReconstructionOptions;
  /**
   * #53 reconstruction mode: 0 = soft value-bilateral penumbra
   * reconstruction (the area-light path, default), 1 = hard ring-rule
   * binomial edge refinement (the single-ray path). The mode selects the
   * WGSL kernel; both mirror the CPU oracle in `shadow-reconstruct.ts`.
   */
  readonly mode?: number;
  /**
   * Render DPR used for the single scene-unit radius -> texel conversion
   * (the DOM already mapped its CSS-px radius through the display DPR once).
   * Must match the render extent's dpr; defaults to the rawVisibility
   * binding's implied 1 when omitted.
   */
  readonly dpr?: number;
  /**
   * #32 optional dispatch band EXPANDED by the filter halo (inclusive texel
   * rows): only those rows are written. `undefined` keeps the historical
   * full-frame dispatch.
   */
  readonly region?: BandRegion;
  /** Optional real GPU timestamp-query writes for this compute pass. */
  readonly timestampWrites?: GpuTimestampWritesLike;
}

export interface ReconstructionOutputBinding {
  readonly buffer: GpuBufferLike;
  /** logical bytes == 4 * width * height (tightly packed f32 scalars) */
  readonly byteLength: number;
  readonly format: "f32";
  /** one tightly packed f32 scalar per texel */
  readonly channels: 1;
  readonly usage: number;
}

export interface ReconstructionPassLastDispatch {
  readonly renderWidth: number;
  readonly renderHeight: number;
  readonly workgroupCountX: number;
  /** sanitized integer filter radius actually run (soft mode) */
  readonly radiusTexels: number;
  /** #53 kernel mode actually run: 0 = soft bilateral, 1 = hard refinement */
  readonly mode: number;
}

export interface ReconstructionPassSnapshot {
  readonly width: number;
  readonly height: number;
  /** render DPR the radius conversion used */
  readonly dpr: number;
  readonly output: ReconstructionOutputBinding;
  /** the effective (sanitized) options that ran */
  readonly options: ReturnType<typeof sanitizeReconstructionOptions>;
  readonly lastDispatch: ReconstructionPassLastDispatch;
  /**
   * The per-HeightPass-dispatch provenance propagated from the input fields
   * (all three share it); downstream consumers re-validate it like every
   * other field-stage snapshot.
   */
  readonly provenance: HeightPassProvenance;
}

export interface ReconstructionPassDispatchStats {
  readonly newAllocations: number;
  readonly allocationCount: number;
  readonly totalAllocationBytes: number;
  /**
   * The workgroup count THIS dispatch invocation actually dispatched:
   * `ceil(bandTexels / WORKGROUP_SIZE)` for a partial band (== the single
   * `pass.dispatchWorkgroups` call), `ceil(fullTexels / WORKGROUP_SIZE)`
   * for a full frame, and the LOGICAL band total on a limit-split chunked
   * frame (the chunks tile the band; `submissions` reports the chunk
   * count). Never the full-frame count of a partial band.
   */
  readonly workgroupCountX: number;
  /** queue.submit calls (1 single-chunk, more on a limit-split band) */
  readonly submissions: number;
}

type ReconstructionAllocationName = "uniform" | "outReconstructed";

interface CachedReconstructionPipeline {
  layout: GpuBindGroupLayoutLike;
  pipelineLayout: GpuPipelineLayoutLike;
  pipeline: GpuComputePipelineLike;
  module: GpuShaderModuleLike;
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function sumOf(sizes: Map<string, number>): number {
  let total = 0;
  for (const size of sizes.values()) {
    total += size;
  }
  return total;
}

/**
 * Timestamp descriptor for ONE chunk of a limit-split stage (mirrors the
 * shadow pass semantics: beginning query on the first chunk, end query on
 * the last).
 */
function chunkTimestampDescriptor(
  writes: GpuTimestampWritesLike | undefined,
  isFirstChunk: boolean,
  isLastChunk: boolean,
): { readonly timestampWrites: GpuTimestampWritesLike } | undefined {
  if (writes === undefined || (!isFirstChunk && !isLastChunk)) {
    return undefined;
  }
  return {
    timestampWrites: {
      querySet: writes.querySet,
      ...(isFirstChunk && writes.beginningOfPassWriteIndex !== undefined
        ? { beginningOfPassWriteIndex: writes.beginningOfPassWriteIndex }
        : {}),
      ...(isLastChunk && writes.endOfPassWriteIndex !== undefined
        ? { endOfPassWriteIndex: writes.endOfPassWriteIndex }
        : {}),
    },
  };
}

export class ReconstructionPass {
  private readonly allocations = new Map<ReconstructionAllocationName, GpuBufferLike>();
  private readonly allocationSizes = new Map<ReconstructionAllocationName, number>();
  private readonly uniformBytes = new Uint8Array(RECONSTRUCTION_PARAMS_BYTE_LENGTH);
  private newAllocations = 0;
  private lastDispatch: ReconstructionPassLastDispatch | null = null;
  private lastOptions: ReturnType<typeof sanitizeReconstructionOptions> | null = null;
  private lastDpr = 0;
  private lastProvenance: HeightPassProvenance | null = null;
  private cached: CachedReconstructionPipeline | null = null;

  constructor(private readonly device: GpuComputeDeviceLike) {}

  /**
   * Reconstruct one raw visibility field bound to the exact height/ownership
   * fields of the same HeightPass dispatch. Validation, limits and
   * allocation bounds all run BEFORE any device call; execution performs
   * only a uniform upload and the compute submission(s) (no map, no
   * readback).
   */
  dispatch(input: ReconstructionPassInput): ReconstructionPassDispatchStats {
    const { rawVisibility, height, objectId } = input;
    this.assertFields(rawVisibility, height, objectId);
    const width = rawVisibility.width;
    const h = rawVisibility.height;
    const texelCount = width * h;
    if (
      !Number.isInteger(width) || width <= 0 ||
      !Number.isInteger(h) || h <= 0 ||
      !Number.isSafeInteger(texelCount) || texelCount > U32_MAX
    ) {
      throw new Error(
        `reconstruction render extent ${width}x${h} is invalid or exceeds u32`,
      );
    }
    const dpr =
      typeof input.dpr === "number" && Number.isFinite(input.dpr) && input.dpr > 0
        ? input.dpr
        : 1;
    const options = sanitizeReconstructionOptions(input.options ?? {}, dpr);
    if (!options.enabled || options.radiusTexels <= 0) {
      throw new Error(
        "reconstruction pass dispatched with the filter bypassed: callers must skip " +
          "the stage instead (the raw field keeps the historical bytes)",
      );
    }
    // #53 mode: 0 = soft bilateral (default), 1 = hard ring-binomial. The
    // hard mode ignores radiusTexels/heightGate (fixed 3x3 ring semantics).
    const mode =
      input.mode === RECONSTRUCTION_MODE_HARD ? RECONSTRUCTION_MODE_HARD : RECONSTRUCTION_MODE_SOFT;
    const region = assertBandRegion(input.region, h);
    const bandRows = region === null ? h : region.y1 - region.y0 + 1;
    const bandTexels = width * bandRows;
    const dispatchCountX = Math.ceil(bandTexels / RECONSTRUCTION_WORKGROUP_SIZE);
    const yOffset = region === null ? 0 : region.y0 * width;
    const regionEnd = region === null ? 0 : yOffset + bandTexels;
    const maxWorkgroups = this.assertDeviceLimits();
    const chunks = planDispatchChunks(
      region === null ? 0 : region.y0,
      region === null ? h - 1 : region.y1,
      width,
      RECONSTRUCTION_WORKGROUP_SIZE,
      maxWorkgroups,
    );
    const outputBytes = texelCount * RECONSTRUCTION_OUTPUT_BYTES_PER_TEXEL;
    this.assertStorageBindingsWithinLimit([
      ["rawVisibility input", rawVisibility.byteLength],
      ["height input", height.byteLength],
      ["objectId input", objectId.byteLength],
      ["reconstruction output", outputBytes],
    ]);
    this.assertAllocationWithinLimits(
      RECONSTRUCTION_PARAMS_BYTE_LENGTH,
      "params uniform",
    );
    this.assertAllocationWithinLimits(outputBytes, "reconstruction output");

    this.ensureAllocation(
      "uniform",
      RECONSTRUCTION_PARAMS_BYTE_LENGTH,
      GPU_USAGE_UNIFORM | GPU_USAGE_COPY_DST,
    );
    this.ensureAllocation("outReconstructed", outputBytes, RECONSTRUCTION_PASS_OUTPUT_USAGE);
    const uniform = this.allocation("uniform");

    const cached = this.ensurePipeline();
    const group = this.device.createBindGroup({
      label: "ukibori-reconstruction-pass",
      layout: cached.layout,
      entries: [
        {
          binding: 0,
          resource: { buffer: uniform, size: RECONSTRUCTION_PARAMS_BYTE_LENGTH },
        },
        {
          binding: 1,
          resource: { buffer: rawVisibility.buffer, size: rawVisibility.byteLength },
        },
        { binding: 2, resource: { buffer: height.buffer, size: height.byteLength } },
        { binding: 3, resource: { buffer: objectId.buffer, size: objectId.byteLength } },
        {
          binding: 4,
          resource: { buffer: this.allocation("outReconstructed"), size: outputBytes },
        },
      ],
    });

    let submissions = 0;
    if (chunks === null) {
      this.packUniform(width, h, options, yOffset, regionEnd, mode);
      this.device.queue.writeBuffer(uniform, 0, this.uniformBytes);
      const encoder = this.device.createCommandEncoder({ label: "ukibori-reconstruction-pass" });
      const pass = encoder.beginComputePass(
        input.timestampWrites === undefined
          ? undefined
          : { timestampWrites: input.timestampWrites },
      );
      pass.setPipeline(cached.pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(dispatchCountX);
      pass.end();
      this.device.queue.submit([encoder.finish()]);
      submissions = 1;
    } else {
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
        const chunk = chunks[chunkIndex];
        const chunkYOffset = chunk.y0 * width;
        this.packUniform(width, h, options, chunkYOffset, chunkYOffset + chunk.texels, mode);
        this.device.queue.writeBuffer(uniform, 0, this.uniformBytes);
        const encoder = this.device.createCommandEncoder({ label: "ukibori-reconstruction-pass" });
        const pass = encoder.beginComputePass(
          chunkTimestampDescriptor(input.timestampWrites, chunkIndex === 0, chunkIndex === chunks.length - 1),
        );
        pass.setPipeline(cached.pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(chunk.workgroups);
        pass.end();
        this.device.queue.submit([encoder.finish()]);
        submissions += 1;
      }
    }

    this.lastDispatch = {
      renderWidth: width,
      renderHeight: h,
      workgroupCountX: dispatchCountX,
      radiusTexels: options.radiusTexels,
      mode,
    };
    this.lastOptions = options;
    this.lastDpr = dpr;
    this.lastProvenance = rawVisibility.provenance;

    const stats: ReconstructionPassDispatchStats = {
      newAllocations: this.newAllocations,
      allocationCount: this.allocations.size,
      totalAllocationBytes: sumOf(this.allocationSizes),
      // #43 review: report the workgroup count THIS invocation actually
      // dispatched —ceil(bandTexels / WORKGROUP_SIZE) on a partial band,
      // ceil(fullTexels / WORKGROUP_SIZE) on a full frame —matching
      // `lastDispatch.workgroupCountX` and the other field passes'
      // semantics (the LOGICAL total for a band; on a limit-split chunked
      // frame the chunks tile the band and this is the documented total,
      // with `submissions` reporting the chunk count). Never the full-frame
      // count of an unrelated extent.
      workgroupCountX: dispatchCountX,
      submissions,
    };
    this.newAllocations = 0;
    return stats;
  }

  /** Stable read-only snapshot; throws before the first successful dispatch. */
  getSnapshot(): ReconstructionPassSnapshot {
    if (this.lastDispatch === null || this.lastOptions === null) {
      throw new Error("no dispatch: dispatch() has not completed or dispose() was called");
    }
    const texelCount = this.lastDispatch.renderWidth * this.lastDispatch.renderHeight;
    return {
      width: this.lastDispatch.renderWidth,
      height: this.lastDispatch.renderHeight,
      dpr: this.lastDpr,
      output: {
        buffer: this.allocation("outReconstructed"),
        byteLength: texelCount * RECONSTRUCTION_OUTPUT_BYTES_PER_TEXEL,
        format: "f32",
        channels: 1,
        usage: RECONSTRUCTION_PASS_OUTPUT_USAGE,
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

  private assertFields(
    rawVisibility: ShadowFieldBinding,
    height: ShadowFieldBinding,
    objectId: ShadowFieldBinding,
  ): void {
    const provenance = rawVisibility.provenance;
    if (height.provenance !== provenance || objectId.provenance !== provenance) {
      throw new Error(
        "mixed provenance: rawVisibility, height and objectId must come from one " +
          "HeightPass dispatch chain (the raw visibility carries its producer's token)",
      );
    }
    for (const [name, binding] of [
      ["rawVisibility", rawVisibility],
      ["height", height],
      ["objectId", objectId],
    ] as const) {
      if (!Number.isInteger(binding.width) || !Number.isInteger(binding.height)) {
        throw new Error(`${name} binding extent ${binding.width}x${binding.height} is invalid`);
      }
      const expectedBytes = binding.width * binding.height * 4;
      if (binding.byteLength !== expectedBytes) {
        throw new Error(
          `${name} binding byteLength ${binding.byteLength} != expected ${expectedBytes}`,
        );
      }
      const expectedFormat = name === "objectId" ? "u32" : "f32";
      if (binding.format !== expectedFormat) {
        throw new Error(`${name} binding format ${String(binding.format)} != ${expectedFormat}`);
      }
      if ((binding.usage & GPU_USAGE_STORAGE) === 0) {
        throw new Error(`${name} binding usage 0x${binding.usage.toString(16)} lacks STORAGE`);
      }
      const required = Math.max(expectedBytes, MIN_PASS_ALLOCATION_BYTES);
      if (binding.buffer.size < required) {
        throw new Error(
          `${name} buffer size ${binding.buffer.size} < required ${required}`,
        );
      }
    }
  }

  private assertDeviceLimits(): number {
    const limits: GpuLimitsLike = this.device.limits;
    const maxWorkgroupX = positiveLimit(limits.maxComputeWorkgroupSizeX, 256);
    const maxInvocations = positiveLimit(limits.maxComputeInvocationsPerWorkgroup, 256);
    if (
      RECONSTRUCTION_WORKGROUP_SIZE > maxWorkgroupX ||
      RECONSTRUCTION_WORKGROUP_SIZE > maxInvocations
    ) {
      throw new Error(
        `workgroup size ${RECONSTRUCTION_WORKGROUP_SIZE} exceeds device limits ` +
          `(maxComputeWorkgroupSizeX ${maxWorkgroupX}, ` +
          `maxComputeInvocationsPerWorkgroup ${maxInvocations})`,
      );
    }
    return positiveLimit(limits.maxComputeWorkgroupsPerDimension, DEFAULT_MAX_WORKGROUPS);
  }

  private assertStorageBindingsWithinLimit(
    bindings: ReadonlyArray<readonly [label: string, byteLength: number]>,
  ): void {
    const maxStorage = positiveLimit(
      this.device.limits.maxStorageBufferBindingSize,
      DEFAULT_MAX_STORAGE_BYTES,
    );
    const invalid = bindings.filter(
      ([, byteLength]) =>
        !Number.isSafeInteger(byteLength) || byteLength <= 0 || byteLength > maxStorage,
    );
    if (invalid.length > 0) {
      throw new Error(
        `storage binding ranges exceed maxStorageBufferBindingSize ${maxStorage}: ` +
          invalid.map(([label, byteLength]) => `${label} ${byteLength} bytes`).join(", "),
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
    name: ReconstructionAllocationName,
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

  private allocation(name: ReconstructionAllocationName): GpuBufferLike {
    const buffer = this.allocations.get(name);
    if (buffer === undefined) {
      throw new Error(`missing allocation for ${name}`);
    }
    return buffer;
  }

  // -- host packing (little-endian; offsets pinned by the WGSL docs) --------

  private packUniform(
    width: number,
    height: number,
    options: ReturnType<typeof sanitizeReconstructionOptions>,
    yOffset: number,
    regionEnd: number,
    mode: number,
  ): void {
    const view = new DataView(this.uniformBytes.buffer);
    view.setUint32(0, width, true);
    view.setUint32(4, height, true);
    view.setUint32(8, options.radiusTexels, true);
    view.setUint32(12, yOffset, true);
    view.setUint32(16, regionEnd, true);
    // #43 DPR-invariant scene semantics: the height gate is a scene-unit
    // length sanitized from the options (the DOM scales its CSS default by
    // the display DPR once, so edge-preservation is identical in CSS space).
    view.setFloat32(20, Math.fround(options.heightGate), true);
    // #53 value-bilateral sigma (soft mode only; the CPU oracle weighs from
    // the same f32 constant).
    view.setFloat32(24, Math.fround(RECONSTRUCTION_VALUE_SIGMA), true);
    // #53 mode: 0 = soft bilateral, 1 = hard ring-rule binomial refinement.
    view.setUint32(28, mode, true);
  }

  // -- pipeline -------------------------------------------------------------

  private ensurePipeline(): CachedReconstructionPipeline {
    if (this.cached !== null) {
      return this.cached;
    }
    // Explicit layouts only (never layout: "auto"). Storage count: 3
    // read-only + 1 read_write = 4, below the spec-minimum 8.
    const layout = this.device.createBindGroupLayout({
      label: "ukibori-reconstruction-pass",
      entries: [
        {
          binding: 0,
          visibility: COMPUTE_STAGE_VISIBILITY,
          buffer: {
            type: "uniform",
            hasDynamicOffset: false,
            minBindingSize: RECONSTRUCTION_PARAMS_BYTE_LENGTH,
          },
        },
        {
          binding: 1,
          visibility: COMPUTE_STAGE_VISIBILITY,
          buffer: { type: "read-only-storage", hasDynamicOffset: false, minBindingSize: 4 },
        },
        {
          binding: 2,
          visibility: COMPUTE_STAGE_VISIBILITY,
          buffer: { type: "read-only-storage", hasDynamicOffset: false, minBindingSize: 4 },
        },
        {
          binding: 3,
          visibility: COMPUTE_STAGE_VISIBILITY,
          buffer: { type: "read-only-storage", hasDynamicOffset: false, minBindingSize: 4 },
        },
        {
          binding: 4,
          visibility: COMPUTE_STAGE_VISIBILITY,
          buffer: {
            type: "storage",
            hasDynamicOffset: false,
            minBindingSize: RECONSTRUCTION_OUTPUT_BYTES_PER_TEXEL,
          },
        },
      ],
    });
    const module = this.device.createShaderModule({
      code: RECONSTRUCTION_PASS_WGSL,
      label: "ukibori-reconstruction-pass",
    });
    const pipelineLayout = this.device.createPipelineLayout({
      label: "ukibori-reconstruction-pass",
      bindGroupLayouts: [layout],
    });
    const pipeline = this.device.createComputePipeline({
      label: "ukibori-reconstruction-pass",
      layout: pipelineLayout,
      compute: { module, entryPoint: "main" },
    });
    this.cached = { layout, pipelineLayout, pipeline, module };
    return this.cached;
  }
}

// -- downstream binding builders ---------------------------------------------

/**
 * Build the narrow visibility binding consumed by `LightingPass` from the
 * reconstruction snapshot —the exact reconstructed buffer with the
 * propagated per-HeightPass-dispatch provenance token. The pipeline uses
 * this builder exactly when reconstruction is ACTIVE for the frame; a
 * bypassed frame keeps consuming the raw shadow output through
 * `lightingVisibilityBindingFromShadowPass`.
 */
export function lightingVisibilityBindingFromReconstructionPass(
  snapshot: ReconstructionPassSnapshot,
): LightingFieldBinding {
  const output = snapshot.output;
  return {
    buffer: output.buffer,
    byteLength: output.byteLength,
    format: "f32",
    channels: output.channels,
    usage: output.usage,
    width: snapshot.width,
    height: snapshot.height,
    provenance: snapshot.provenance,
  };
}

/**
 * Build the narrow #43 visibility binding consumed by `PresentationPass`
 * from the reconstruction snapshot (same contract as
 * `presentationVisibilityBindingFromShadowPass`).
 */
export function presentationVisibilityBindingFromReconstructionPass(
  snapshot: ReconstructionPassSnapshot,
): PresentationInputBinding {
  const output = snapshot.output;
  return {
    buffer: output.buffer,
    byteLength: output.byteLength,
    format: "f32",
    channels: output.channels,
    usage: output.usage,
    width: snapshot.width,
    height: snapshot.height,
    dpr: snapshot.dpr,
    provenance: snapshot.provenance,
  };
}


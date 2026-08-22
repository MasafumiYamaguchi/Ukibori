import type { EncodedScene } from "./encode";
import type { EncodedHeader, SceneSectionLayout } from "./layout";
import {
  GPU_USAGE_COPY_DST,
  GPU_USAGE_COPY_SRC,
  GPU_USAGE_STORAGE,
  HEADER_SIZE,
  MASK_OFFSET_HEIGHT,
  MASK_OFFSET_WIDTH,
  MASK_STRIDE,
  MATERIAL_STRIDE,
  SURFACE_STRIDE,
  sceneSectionLayout,
} from "./layout";
import type { GpuBufferLike, SceneBindings } from "./uploader";
import type { BandRegion } from "./tiles";
import { assertBandRegion, planDispatchChunks } from "./tiles";
import { validateEncodedScene } from "./validate";
import {
  COMPOSE_CASTER_HEIGHT_WGSL,
  COMPOSE_COVERAGE_WGSL,
  COMPOSE_HEIGHT_WGSL,
  COMPOSE_MATERIAL_ID_WGSL,
  COMPOSE_OBJECT_ID_WGSL,
  HEIGHT_PASS_PARAMS_BYTE_LENGTH,
  MASK_META_CANDIDATE_BASE,
  MASK_META_FULL_SENTINEL,
  MASK_META_STRIDE,
  MASK_SDF_WGSL,
  WORKGROUP_SIZE,
} from "./height-pass-wgsl";

/**
 * #25 height composition compute stage — the first real WebGPU compute
 * pipeline. It consumes the five frozen #24 `SceneUploader.getBindings()`
 * buffers DIRECTLY (never copied into new host/GPU buffers) and produces
 * GPU-resident height, coverage, objectId, materialId and CASTER-HEIGHT
 * fields for the ABI render extent, matching the CPU reference
 * (`composeHeightField` + `composeCasterHeightField` +
 * `roundedRectSdf`/`evaluateProfile`/`computeMaskSdf`).
 *
 * ## All five scene buffers are genuinely consumed by the GPU
 *
 * - sceneHeader (binding 0): dims/counts/DPR read directly by every pass
 * - surfaces (binding 1): geometry, owner and tie resolution
 * - masks (binding 2): mask dimensions/format/pixelOffset (SDF pass and
 *   mask-shape sampling)
 * - maskPixels (binding 3): GPU mask SDF generated from uploaded alpha
 * - materials (binding 4): MaterialRecord flags in the validity-dependent
 *   material-id output path
 *
 * ## Passes and the per-stage storage limit
 *
 * `maxStorageBuffersPerShaderStage` has a SPEC MINIMUM of 8, so the
 * composition stage is split into FIVE output-specific compute passes:
 *
 * - mask-SDF pass (only when the scene has masks): 5 scene storage +
 *   maskMeta + maskWorkspace = 7
 * - compose passes x5 (height f32, coverage u32, objectId u32,
 *   materialId u32, casterHeight f32), one per output allocation: 5 scene
 *   storage + maskMeta + maskWorkspace + exactly ONE output storage = 8,
 *   plus the uniform (uniforms do not count toward the limit)
 *
 * Every full-field compose pass recomputes the deterministic owner from the
 * same pure scene+texel function, so all four full outputs agree; the
 * caster-height pass independently recomputes a CASTER-ONLY owner (surfaces
 * with the ABI `FLAG_CASTS_SHADOW` bit only, see `casterOwnerAt`), so a
 * non-casting top surface never hides a lower casting surface;
 * `getSnapshot().lastDispatch.composePasses` is 5. Each output lives in its
 * own allocation; all outputs are `STORAGE | COPY_SRC | COPY_DST`, never
 * mapped, and exposed through the stable read-only snapshot for later
 * passes (#26/#27 and beyond).
 *
 * ## Validation before ANY device call
 *
 * `dispatch()` runs, in order, before any allocation, write, pipeline,
 * bind-group or encoder call:
 *
 * 1. the STRICT byte-level `validateEncodedScene` (surface
 *    shape/profile/material/maskIndex records, reserved bytes, ranges,
 *    derived data) — rejected with the collected error list
 * 2. a provenance check: `bindings.provenance` must be the exact `bytes`
 *    object that was uploaded, so same-length bindings from a different
 *    scene are rejected (O(1), no scene-section copy)
 * 3. section byte-length/buffer-size cross-checks against the header
 * 4. device limits: workgroup size, `maxStorageBuffersPerShaderStage >= 8`
 *    (when reported), and the dispatch counts against
 *    `maxComputeWorkgroupsPerDimension` (default 65535): an oversized
 *    1D compose dispatch is SPLIT into sequential row-band chunks (the #32
 *    region machinery, one params write + submission per chunk); only an
 *    oversized mask-SDF workspace remains fatal
 * 5. u32-bounded host arithmetic: render texel counts, per-mask padded cell
 *    counts, workspace byte offsets, totalMaskCells and maskMeta allocation
 *    bytes are all checked against U32_MAX and safe integers
 * 6. every allocation (uniform, mask meta, workspace, outputs) bounded by
 *    device limits
 *
 * ## Structural device interface
 *
 * The class drives a narrow structural `GpuComputeDeviceLike` mirror of the
 * real WebGPU device surface used by this pass. The real `GPUDevice` cast
 * into this interface is the ONLY boundary (harness code); the mock in Node
 * tests implements the same surface, so no fabricated WebGPU methods exist.
 */
export const HEIGHT_PASS_OUTPUT_USAGE = GPU_USAGE_STORAGE | GPU_USAGE_COPY_SRC | GPU_USAGE_COPY_DST;

/** `GPUShaderStage.COMPUTE` spec bit value (0x1=VERTEX, 0x2=FRAGMENT, 0x4=COMPUTE). */
export const COMPUTE_STAGE_VISIBILITY = 0x4;

/** `GPUBufferUsage.UNIFORM` spec bit value (usable in Node tests). */
export const GPU_USAGE_UNIFORM = 0x40;

/** Default `maxStorageBufferBindingSize` / `maxBufferSize` (spec minimum). */
const DEFAULT_MAX_STORAGE_BYTES = 256 * 1024 * 1024;

/** Default `maxComputeWorkgroupsPerDimension` (spec minimum). */
const DEFAULT_MAX_WORKGROUPS = 65535;

/**
 * Largest u32 value. Every host value that is packed into a WGSL u32
 * (render texel counts, per-mask padded cell counts, workspace byte
 * offsets, totalMaskCells, maskMeta allocation bytes) or used in in-shader
 * u32 arithmetic must be <= this before any device call.
 */
const U32_MAX = 0xffffffff;

/**
 * Storage buffers per shader stage required by this pass: the spec minimum
 * of `maxStorageBuffersPerShaderStage` (8). The SDF stage uses 7, every
 * compose stage exactly 8.
 */
const REQUIRED_STORAGE_BUFFERS_PER_STAGE = 8;

/** Smallest legal allocation for derived sections (mirrors #24's floor). */
const MIN_PASS_ALLOCATION_BYTES = 16;

// ---------------------------------------------------------------------------
// Structural device surface (see class docs)
// ---------------------------------------------------------------------------

export interface GpuLimitsLike {
  readonly maxStorageBufferBindingSize: number;
  readonly maxBufferSize?: number;
  readonly maxComputeWorkgroupSizeX?: number;
  readonly maxComputeInvocationsPerWorkgroup?: number;
  /** spec minimum 65535; 1D dispatch counts must not exceed it */
  readonly maxComputeWorkgroupsPerDimension?: number;
  /** spec minimum 8; the pass needs >= 8 storage buffers per stage */
  readonly maxStorageBuffersPerShaderStage?: number;
}

export interface GpuCommandBufferLike {
  readonly label?: string;
}

export interface GpuShaderModuleLike {
  readonly label?: string;
}

export interface GpuComputePipelineLike {
  readonly label?: string;
}

export interface GpuBindGroupLike {
  readonly label?: string;
}

export interface GpuBindGroupLayoutLike {
  readonly label?: string;
}

export interface GpuPipelineLayoutLike {
  readonly label?: string;
}

export interface GpuBufferBindingLike {
  readonly buffer: GpuBufferLike;
  readonly offset?: number;
  readonly size?: number;
}

export interface GpuBindGroupLayoutEntryLike {
  readonly binding: number;
  readonly visibility: number;
  readonly buffer?: {
    readonly type?: string;
    readonly hasDynamicOffset?: boolean;
    readonly minBindingSize?: number;
  };
}

export interface GpuBindGroupEntryLike {
  readonly binding: number;
  readonly resource: GpuBufferBindingLike;
}

export interface GpuComputePassEncoderLike {
  setPipeline(pipeline: GpuComputePipelineLike): void;
  setBindGroup(index: number, bindGroup: GpuBindGroupLike): void;
  dispatchWorkgroups(
    workgroupCountX: number,
    workgroupCountY?: number,
    workgroupCountZ?: number,
  ): void;
  end(): void;
}

export interface GpuCommandEncoderLike {
  beginComputePass(): GpuComputePassEncoderLike;
  finish(): GpuCommandBufferLike;
}

export interface GpuComputeDeviceLike {
  readonly limits: GpuLimitsLike;
  readonly queue: {
    writeBuffer(
      buffer: GpuBufferLike,
      dstByteOffset: number,
      source: Uint8Array,
      srcOffset?: number,
      srcSize?: number,
    ): void;
    submit(commandBuffers: readonly GpuCommandBufferLike[]): void;
  };
  createBuffer(desc: { readonly size: number; readonly usage: number; readonly label?: string }): GpuBufferLike;
  createShaderModule(desc: { readonly code: string; readonly label?: string }): GpuShaderModuleLike;
  createComputePipeline(desc: {
    readonly layout: GpuPipelineLayoutLike;
    readonly compute: { readonly module: GpuShaderModuleLike; readonly entryPoint: string };
    readonly label?: string;
  }): GpuComputePipelineLike;
  createBindGroupLayout(desc: {
    readonly entries: readonly GpuBindGroupLayoutEntryLike[];
    readonly label?: string;
  }): GpuBindGroupLayoutLike;
  createPipelineLayout(desc: {
    readonly bindGroupLayouts: readonly GpuBindGroupLayoutLike[];
    readonly label?: string;
  }): GpuPipelineLayoutLike;
  createBindGroup(desc: {
    readonly layout: GpuBindGroupLayoutLike;
    readonly entries: readonly GpuBindGroupEntryLike[];
    readonly label?: string;
  }): GpuBindGroupLike;
  createCommandEncoder(desc?: { readonly label?: string }): GpuCommandEncoderLike;
}

// ---------------------------------------------------------------------------
// Snapshots and stats
// ---------------------------------------------------------------------------

export type HeightPassOutputFormat = "f32" | "u32";

export interface HeightPassOutputBinding {
  /** GPU allocation (never undefined after the first dispatch) */
  readonly buffer: GpuBufferLike;
  /** logical field bytes (renderWidth * renderHeight * 4) */
  readonly byteLength: number;
  readonly format: HeightPassOutputFormat;
  /** `STORAGE | COPY_SRC | COPY_DST` */
  readonly usage: number;
}

/** Stable read-only output binding snapshot for later passes (#26/#27+). */
export interface HeightPassOutputs {
  /** f32 absolute scene-space z (0 = background/base plane) */
  readonly height: HeightPassOutputBinding;
  /** u32 1 when a surface owns the texel, 0 for background */
  readonly coverage: HeightPassOutputBinding;
  /** u32 ABI surface index, or NO_OWNER */
  readonly objectId: HeightPassOutputBinding;
  /** u32 ABI material index, or NO_OWNER */
  readonly materialId: HeightPassOutputBinding;
  /**
   * f32 caster-only height field (#27): same shape/profile/tie rules as
   * `height`, but composed ONLY from surfaces with `FLAG_CASTS_SHADOW`; 0.0
   * where no casting surface owns the texel. Sampled bilinearly by the
   * #27 ShadowPass for occlusion.
   */
  readonly casterHeight: HeightPassOutputBinding;
}

export interface HeightPassLastDispatch {
  readonly renderWidth: number;
  readonly renderHeight: number;
  /** ceil(texels / WORKGROUP_SIZE); identical for every compose pass */
  readonly workgroupCountX: number;
  readonly maskCount: number;
  readonly totalMaskCells: number;
  /** 1 when the mask-SDF pass ran, 0 for mask-free scenes */
  readonly maskSdfPasses: number;
  /** 5: height, coverage, objectId, materialId, casterHeight — one compute pass per output */
  readonly composePasses: number;
}

/**
 * O(1) identity for one successful HeightPass dispatch. `sceneBytes`
 * proves which encoded scene was consumed, while the provenance object
 * itself is freshly allocated per dispatch so later passes can reject a
 * mixture of fields from two executions of that same scene.
 */
export interface HeightPassProvenance {
  readonly sceneBytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
}

export interface HeightPassSnapshot {
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
  readonly workgroupSize: number;
  readonly outputs: HeightPassOutputs;
  readonly lastDispatch: HeightPassLastDispatch;
  /**
   * O(1) provenance identity of the last successful `dispatch()`. The
   * object is unique per dispatch and holds the exact scene `bytes`
   * reference, so later passes can reject both foreign scenes and mixed
   * fields from separate dispatches of the same scene.
   */
  readonly provenance: HeightPassProvenance;
}

export interface HeightPassDispatchStats {
  readonly newAllocations: number;
  readonly allocationCount: number;
  readonly totalAllocationBytes: number;
  readonly maskSdfPasses: number;
  readonly composePasses: number;
  /**
   * queue.submit calls performed by this dispatch: 1 on the historical
   * single-submission path, `1 + composeChunks` when the compose stage was
   * limit-split into sequential band chunks (the SDF pass then owns its
   * own submission).
   */
  readonly submissions: number;
}

/** u32-bounded mask-SDF workspace layout (see `computeMaskWorkspaceLayout`). */
export interface MaskWorkspaceLayout {
  /** per-mask workspace byte offsets, mask order; every value <= U32_MAX */
  readonly offsets: number[];
  /** total padded-cell bytes (== 4 * totalMaskCells), <= U32_MAX */
  readonly workspaceBytes: number;
}

/**
 * Genuinely derived per-mask workspace layout. Every value that will be
 * packed into a WGSL u32 or used by in-shader u32 arithmetic is
 * bounds-checked HERE, before any device call: each per-mask padded cell
 * count and the cumulative workspace byte offsets must be safe integers
 * and <= U32_MAX. `workspaceBytes` is always 4 * totalMaskCells, so
 * `totalMaskCells` (written into the params uniform) and the in-shader
 * cumulative cell lookup can never overflow u32. Throws with a specific
 * message on violation.
 */
export function computeMaskWorkspaceLayout(cellCounts: readonly number[]): MaskWorkspaceLayout {
  const offsets: number[] = [];
  let workspaceBytes = 0;
  for (let i = 0; i < cellCounts.length; i++) {
    const cells = cellCounts[i];
    if (!Number.isSafeInteger(cells) || cells < 0 || cells > U32_MAX) {
      throw new Error(
        `mask[${i}] padded cell count ${cells} exceeds u32 (${U32_MAX})`,
      );
    }
    const cellBytes = cells * 4;
    const next = workspaceBytes + cellBytes;
    if (!Number.isSafeInteger(next) || next > U32_MAX) {
      throw new Error(
        `mask[${i}] workspace byte offset ${next} exceeds u32 (${U32_MAX})`,
      );
    }
    offsets.push(workspaceBytes);
    workspaceBytes = next;
  }
  return { offsets, workspaceBytes };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

type AllocationName =
  | "uniform"
  | "maskMeta"
  | "maskWorkspace"
  | "outHeight"
  | "outCoverage"
  | "outObjectId"
  | "outMaterialId"
  | "outCasterHeight";

/** Compose passes in dispatch order; one per output allocation. */
const COMPOSE_PASSES: ReadonlyArray<{
  readonly name: AllocationName;
  readonly module: string;
  readonly format: HeightPassOutputFormat;
}> = [
  { name: "outHeight", module: COMPOSE_HEIGHT_WGSL, format: "f32" },
  { name: "outCoverage", module: COMPOSE_COVERAGE_WGSL, format: "u32" },
  { name: "outObjectId", module: COMPOSE_OBJECT_ID_WGSL, format: "u32" },
  { name: "outMaterialId", module: COMPOSE_MATERIAL_ID_WGSL, format: "u32" },
  { name: "outCasterHeight", module: COMPOSE_CASTER_HEIGHT_WGSL, format: "f32" },
];

const SCENE_BINDING_MIN_SIZES: ReadonlyArray<readonly [number, number]> = [
  [0, HEADER_SIZE],
  [1, SURFACE_STRIDE],
  [2, MASK_STRIDE],
  [3, 4],
  [4, MATERIAL_STRIDE],
];

interface CachedPipelines {
  sceneLayout: GpuBindGroupLayoutLike;
  sdfLayout: GpuBindGroupLayoutLike;
  composeLayout: GpuBindGroupLayoutLike;
  sdfPipeline: GpuComputePipelineLike;
  composePipelines: readonly GpuComputePipelineLike[];
}

export class HeightPass {
  private readonly allocations = new Map<AllocationName, GpuBufferLike>();
  private readonly allocationSizes = new Map<AllocationName, number>();
  private readonly uniformBytes = new Uint8Array(HEIGHT_PASS_PARAMS_BYTE_LENGTH);
  private maskMetaBytes = new Uint8Array(MIN_PASS_ALLOCATION_BYTES);
  /** logical byte length of the CURRENT frame's maskMeta layout */
  private maskMetaLogicalBytes = MIN_PASS_ALLOCATION_BYTES;
  private newAllocations = 0;
  private lastDispatch: HeightPassLastDispatch | null = null;
  private lastDpr = 0;
  private lastProvenance: HeightPassProvenance | null = null;
  private pipelines: CachedPipelines | null = null;

  constructor(private readonly device: GpuComputeDeviceLike) {}

  /**
   * Compose the height/coverage/objectId/materialId fields for one encoded
   * scene bound through `SceneUploader`. Strict validation, provenance,
   * limits and allocation bounds all run BEFORE any device call; normal
   * execution then performs only GPU uploads and compute submission (no
   * map, no readback).
   *
   * `options.region` (#32) restricts the five compose passes to the
   * inclusive texel rows `[y0, y1]` (a full-width dispatch band): the SDF
   * pass always runs in full, every compose pass dispatches
   * `ceil(bandTexels / WORKGROUP_SIZE)` workgroups and the in-shader index
   * adds `y0 * renderWidth`, so texels outside the band are never written
   * (they are retained by the scheduler). The band is bounds-safe by
   * construction (it never exceeds the render extent). `undefined` keeps
   * the historical full-frame behavior byte-for-byte.
   *
   * `options.candidates` (#32) is the ACTUAL conservative culling bin: the
   * ORIGINAL surface indices the compose passes iterate on a partial
   * frame, packed into the reused `maskMeta` buffer (element 0 = count,
   * elements 1..count = original indices; `null` packs the full-frame
   * sentinel and the shaders iterate every original index). A zero-length
   * list is legal (a zero-candidate band — the shaders write the
   * cleared/background outputs without iterating).
   */
  dispatch(
    scene: EncodedScene,
    bindings: SceneBindings,
    options?: { readonly region?: BandRegion; readonly candidates?: readonly number[] },
  ): HeightPassDispatchStats {
    const validation = validateEncodedScene(scene.bytes);
    if (!validation.ok || validation.header === undefined) {
      throw new Error(`invalid encoded scene: ${validation.errors.join("; ")}`);
    }
    const header = validation.header;
    if (bindings.provenance !== scene.bytes) {
      throw new Error(
        "bindings provenance does not match the dispatched scene: " +
          "upload the exact EncodedScene being dispatched and reuse its bindings",
      );
    }
    const layout = sceneSectionLayout(header);
    this.assertDispatchInput(header, layout, bindings);
    // #32 ACTUAL surface culling: the candidate bin is only meaningful with
    // a partial dispatch region (the sentinel covers full frames), and must
    // be unique, strictly ascending, valid ORIGINAL surface indices.
    const region = assertBandRegion(options?.region, header.renderHeight);
    const candidates = this.assertCandidates(options?.candidates, header.surfaceCount);
    if (candidates !== null && region === null) {
      throw new Error(
        "candidate surface indices require a partial dispatch region: full frames " +
          "use the maskMeta sentinel and iterate every original index",
      );
    }
    const { offsets: maskOffsets, workspaceBytes } = this.readMaskWorkspaceOffsets(
      scene.bytes,
      header,
      layout,
    );
    const totalMaskCells = workspaceBytes / 4;
    const texelCount = header.renderWidth * header.renderHeight;
    // #32 region dispatch: the compose passes cover only the band rows; the
    // SDF pass (mask workspace generation) always runs in full.
    const bandRows = region === null ? header.renderHeight : region.y1 - region.y0 + 1;
    const bandTexels = header.renderWidth * bandRows;
    const yOffset = region === null ? 0 : region.y0 * header.renderWidth;
    // exclusive texel end of the dispatched region: 0 = full-frame sentinel;
    // on a band the shader guard regionEnd != 0 && g >= regionEnd stops the
    // dispatch padding from ever writing a retained texel outside the band
    const regionEnd = region === null ? 0 : yOffset + bandTexels;
    const composeWorkgroups = ceilDiv(bandTexels, WORKGROUP_SIZE);
    const sdfWorkgroups = totalMaskCells > 0 ? ceilDiv(totalMaskCells, WORKGROUP_SIZE) : 0;
    // The per-dimension workgroup cap applies to EVERY dispatch dimension,
    // so a 1D compose dispatch above it must be SPLIT into sequential band
    // chunks (each within the cap; the #32 region machinery reused as-is).
    // null = the whole band fits one dispatch (historical path).
    const maxWorkgroups = this.assertDeviceLimits(composeWorkgroups, sdfWorkgroups);
    const composeChunks = planDispatchChunks(
      region === null ? 0 : region.y0,
      region === null ? header.renderHeight - 1 : region.y1,
      header.renderWidth,
      WORKGROUP_SIZE,
      maxWorkgroups,
    );
    this.ensureAllocations(maskOffsets.length, header.surfaceCount, texelCount, totalMaskCells);

    this.packUniform(totalMaskCells, yOffset, regionEnd);
    this.packMaskMeta(maskOffsets, header.surfaceCount, candidates);
    const uniform = this.allocation("uniform");
    const maskMeta = this.allocation("maskMeta");
    this.device.queue.writeBuffer(uniform, 0, this.uniformBytes);
    // write only the logical bytes (the reusable buffer may be larger than
    // this frame's 1 + surfaceCount + maskCount layout; the zero-fill in
    // packMaskMeta keeps every freshly-written element deterministic)
    this.device.queue.writeBuffer(
      maskMeta,
      0,
      this.maskMetaBytes.subarray(0, this.maskMetaLogicalBytes),
    );

    const cached = this.ensurePipelines();
    const sceneGroup = this.createSceneBindGroup(bindings, cached.sceneLayout);
    const sdfGroup = this.createSdfBindGroup(cached.sdfLayout);
    const composeGroups = this.createComposeBindGroups(cached.composeLayout);

    let maskSdfPasses = 0;
    let submissions = 0;
    if (composeChunks === null) {
      // Historical frame: the SDF pass and all five compose passes share
      // exactly one encoder and one queue submission.
      const encoder = this.device.createCommandEncoder({ label: "ukibori-height-pass" });
      if (totalMaskCells > 0) {
        const pass = encoder.beginComputePass();
        pass.setPipeline(cached.sdfPipeline);
        pass.setBindGroup(0, sceneGroup);
        pass.setBindGroup(1, sdfGroup);
        pass.dispatchWorkgroups(sdfWorkgroups);
        pass.end();
        maskSdfPasses = 1;
      }
      for (let i = 0; i < COMPOSE_PASSES.length; i++) {
        const pass = encoder.beginComputePass();
        pass.setPipeline(cached.composePipelines[i]);
        pass.setBindGroup(0, sceneGroup);
        pass.setBindGroup(1, composeGroups[i]);
        pass.dispatchWorkgroups(composeWorkgroups);
        pass.end();
      }
      this.device.queue.submit([encoder.finish()]);
      submissions = 1;
    } else {
      // Limit-split frame: the SDF pass runs ONCE in full (its own
      // submission; it ignores yOffset/regionEnd), then each row chunk
      // re-packs ONLY its yOffset/regionEnd params, writes them and
      // submits the five compose passes. Queue operations execute in issue
      // order, so every chunk's params write lands after the previous
      // submission and before its own passes — each texel row is computed
      // by exactly one chunk. The chunk regions are true partial bands
      // (non-zero regionEnd even when the first chunk starts at row 0).
      if (totalMaskCells > 0) {
        const encoder = this.device.createCommandEncoder({ label: "ukibori-height-pass" });
        const pass = encoder.beginComputePass();
        pass.setPipeline(cached.sdfPipeline);
        pass.setBindGroup(0, sceneGroup);
        pass.setBindGroup(1, sdfGroup);
        pass.dispatchWorkgroups(sdfWorkgroups);
        pass.end();
        this.device.queue.submit([encoder.finish()]);
        maskSdfPasses = 1;
        submissions += 1;
      }
      for (const chunk of composeChunks) {
        const chunkYOffset = chunk.y0 * header.renderWidth;
        this.packUniform(totalMaskCells, chunkYOffset, chunkYOffset + chunk.texels);
        this.device.queue.writeBuffer(uniform, 0, this.uniformBytes);
        const encoder = this.device.createCommandEncoder({ label: "ukibori-height-pass" });
        for (let i = 0; i < COMPOSE_PASSES.length; i++) {
          const pass = encoder.beginComputePass();
          pass.setPipeline(cached.composePipelines[i]);
          pass.setBindGroup(0, sceneGroup);
          pass.setBindGroup(1, composeGroups[i]);
          pass.dispatchWorkgroups(chunk.workgroups);
          pass.end();
        }
        this.device.queue.submit([encoder.finish()]);
        submissions += 1;
      }
    }

    this.lastDispatch = {
      renderWidth: header.renderWidth,
      renderHeight: header.renderHeight,
      workgroupCountX: composeWorkgroups,
      maskCount: header.maskCount,
      totalMaskCells,
      maskSdfPasses,
      composePasses: COMPOSE_PASSES.length,
    };
    this.lastDpr = header.dpr;
    this.lastProvenance = Object.freeze({
      sceneBytes: scene.bytes,
      width: header.renderWidth,
      height: header.renderHeight,
      dpr: header.dpr,
    });

    const stats: HeightPassDispatchStats = {
      newAllocations: this.newAllocations,
      allocationCount: this.allocations.size,
      totalAllocationBytes: sumOf(this.allocationSizes),
      maskSdfPasses,
      composePasses: COMPOSE_PASSES.length,
      submissions,
    };
    this.newAllocations = 0;
    return stats;
  }

  /** Stable read-only snapshot; throws before the first successful dispatch. */
  getSnapshot(): HeightPassSnapshot {
    if (this.lastDispatch === null || this.lastProvenance === null) {
      throw new Error("no dispatch: dispatch() has not completed or dispose() was called");
    }
    return {
      width: this.lastDispatch.renderWidth,
      height: this.lastDispatch.renderHeight,
      dpr: this.lastDpr,
      workgroupSize: WORKGROUP_SIZE,
      outputs: this.getOutputs(),
      lastDispatch: this.lastDispatch,
      provenance: this.lastProvenance,
    };
  }

  /** Stable read-only output bindings for later passes (#26+). */
  getOutputs(): HeightPassOutputs {
    if (this.lastDispatch === null) {
      throw new Error("no dispatch: dispatch() has not completed or dispose() was called");
    }
    const texelBytes = this.lastDispatch.renderWidth * this.lastDispatch.renderHeight * 4;
    return {
      height: this.outputBinding("outHeight", texelBytes, "f32"),
      coverage: this.outputBinding("outCoverage", texelBytes, "u32"),
      objectId: this.outputBinding("outObjectId", texelBytes, "u32"),
      materialId: this.outputBinding("outMaterialId", texelBytes, "u32"),
      casterHeight: this.outputBinding("outCasterHeight", texelBytes, "f32"),
    };
  }

  /** Destroy every owned GPU allocation. Idempotent. */
  dispose(): void {
    for (const buffer of this.allocations.values()) {
      buffer.destroy();
    }
    this.allocations.clear();
    this.allocationSizes.clear();
    this.newAllocations = 0;
    this.lastDispatch = null;
    this.lastDpr = 0;
    this.lastProvenance = null;
  }

  // -- validation (all BEFORE any device call) ------------------------------

  private assertDispatchInput(
    header: EncodedHeader,
    layout: SceneSectionLayout,
    bindings: SceneBindings,
  ): void {
    if (!Number.isInteger(header.renderWidth) || header.renderWidth <= 0) {
      throw new Error(`renderWidth must be a positive integer, got ${header.renderWidth}`);
    }
    if (!Number.isInteger(header.renderHeight) || header.renderHeight <= 0) {
      throw new Error(`renderHeight must be a positive integer, got ${header.renderHeight}`);
    }
    // the texel count is used for allocations AND computed as a u32 product
    // inside every compose shader; it must fit u32 and safe integers
    const texelCount = header.renderWidth * header.renderHeight;
    if (!Number.isSafeInteger(texelCount) || texelCount > U32_MAX) {
      throw new Error(
        `render texel count ${header.renderWidth}x${header.renderHeight} exceeds ` +
          `u32 (${U32_MAX}) or safe integers`,
      );
    }
    if (bindings.sceneByteLength !== header.totalByteLength) {
      throw new Error(
        `bindings.sceneByteLength ${bindings.sceneByteLength} != scene byte length ${header.totalByteLength}`,
      );
    }
    this.assertSection(bindings.header, HEADER_SIZE, "header");
    this.assertSection(bindings.surfaces, header.surfaceCount * SURFACE_STRIDE, "surfaces");
    this.assertSection(bindings.masks, header.maskCount * MASK_STRIDE, "masks");
    this.assertSection(
      bindings.materials,
      header.materialCount * MATERIAL_STRIDE,
      "materials",
    );
    this.assertSection(bindings.maskPixels, layout.maskPixelsByteLength, "maskPixels");
  }

  private assertSection(
    binding: { readonly buffer: GpuBufferLike; readonly byteLength: number },
    expectedByteLength: number,
    name: string,
  ): void {
    if (!Number.isSafeInteger(expectedByteLength) || expectedByteLength < 0) {
      throw new Error(`scene ${name} section byte length ${expectedByteLength} is invalid`);
    }
    if (binding.byteLength !== expectedByteLength) {
      throw new Error(
        `scene ${name} binding byteLength ${binding.byteLength} != expected ${expectedByteLength}`,
      );
    }
    const required = Math.max(expectedByteLength, MIN_PASS_ALLOCATION_BYTES);
    if (binding.buffer.size < required) {
      throw new Error(
        `scene ${name} buffer size ${binding.buffer.size} < required ${required}`,
      );
    }
  }

  /**
   * Device-capability checks shared by both stages. Returns the effective
   * `maxComputeWorkgroupsPerDimension` so the caller can SPLIT an oversized
   * 1D compose dispatch into sequential band chunks (`planDispatchChunks`).
   * Only the mask-SDF stage stays fatal here: its padded workspace has no
   * row structure to chunk along, so a linear dispatch above the cap has no
   * in-pass remedy.
   */
  private assertDeviceLimits(composeWorkgroups: number, sdfWorkgroups: number): number {
    const limits = this.device.limits;
    const maxWorkgroupX = positiveLimit(limits.maxComputeWorkgroupSizeX, 256);
    const maxInvocations = positiveLimit(limits.maxComputeInvocationsPerWorkgroup, 256);
    if (WORKGROUP_SIZE > maxWorkgroupX || WORKGROUP_SIZE > maxInvocations) {
      throw new Error(
        `workgroup size ${WORKGROUP_SIZE} exceeds device limits ` +
          `(maxComputeWorkgroupSizeX ${maxWorkgroupX}, ` +
          `maxComputeInvocationsPerWorkgroup ${maxInvocations})`,
      );
    }
    const maxStorage = limits.maxStorageBuffersPerShaderStage;
    if (
      typeof maxStorage === "number" &&
      Number.isFinite(maxStorage) &&
      maxStorage > 0 &&
      maxStorage < REQUIRED_STORAGE_BUFFERS_PER_STAGE
    ) {
      throw new Error(
        `maxStorageBuffersPerShaderStage ${maxStorage} < ${REQUIRED_STORAGE_BUFFERS_PER_STAGE}: ` +
          `the height pass needs ${REQUIRED_STORAGE_BUFFERS_PER_STAGE} storage bindings ` +
          `per compose stage and 7 per SDF stage`,
      );
    }
    const maxWorkgroups = positiveLimit(limits.maxComputeWorkgroupsPerDimension, DEFAULT_MAX_WORKGROUPS);
    if (sdfWorkgroups > maxWorkgroups) {
      throw new Error(
        `dispatch counts exceed maxComputeWorkgroupsPerDimension ${maxWorkgroups} ` +
          `(sdf ${sdfWorkgroups}, compose ${composeWorkgroups})`,
      );
    }
    return maxWorkgroups;
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

  /**
   * Genuinely derived per-mask metadata: the cumulative padded-cell BYTE
   * offset of each mask's SDF grid inside the workspace. Everything else
   * (dimensions, alphaFormat, pixelOffset) is read from the ABI MaskRecord
   * directly by the shaders. The bytes were strictly validated by
   * `validateEncodedScene` before this point, so the reads are safe.
   */
  private readMaskWorkspaceOffsets(
    bytes: Uint8Array,
    header: EncodedHeader,
    layout: SceneSectionLayout,
  ): MaskWorkspaceLayout {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const cellCounts: number[] = [];
    for (let i = 0; i < header.maskCount; i++) {
      const record = layout.masksOffset + i * MASK_STRIDE;
      const width = view.getUint32(record + MASK_OFFSET_WIDTH, true);
      const height = view.getUint32(record + MASK_OFFSET_HEIGHT, true);
      cellCounts.push((width + 2) * (height + 2));
    }
    return computeMaskWorkspaceLayout(cellCounts);
  }

  // -- allocations ----------------------------------------------------------

  private ensureAllocations(
    maskCount: number,
    surfaceCount: number,
    texelCount: number,
    totalMaskCells: number,
  ): void {
    const workspaceBytes = totalMaskCells * 4;
    const texelBytes = texelCount * 4;
    // #32 layout: element 0 (sentinel/count) + candidate elements
    // 1..1+surfaceCount + mask workspace offsets at 1+surfaceCount+i
    const maskMetaBytes = (MASK_META_CANDIDATE_BASE + surfaceCount + maskCount) * MASK_META_STRIDE;
    this.assertAllocationWithinLimits(HEIGHT_PASS_PARAMS_BYTE_LENGTH, "params uniform");
    if (!Number.isSafeInteger(maskMetaBytes) || maskMetaBytes > U32_MAX) {
      throw new Error(`mask meta allocation of ${maskMetaBytes} bytes exceeds u32 (${U32_MAX})`);
    }
    this.assertAllocationWithinLimits(maskMetaBytes, "mask meta");
    this.assertAllocationWithinLimits(workspaceBytes, "mask SDF workspace");
    this.assertAllocationWithinLimits(texelBytes, "output");
    this.ensureAllocation(
      "uniform",
      HEIGHT_PASS_PARAMS_BYTE_LENGTH,
      GPU_USAGE_UNIFORM | GPU_USAGE_COPY_DST,
    );
    this.ensureAllocation(
      "maskMeta",
      Math.max(maskMetaBytes, MASK_META_STRIDE),
      GPU_USAGE_STORAGE | GPU_USAGE_COPY_DST,
    );
    this.ensureAllocation("maskWorkspace", workspaceBytes, GPU_USAGE_STORAGE | GPU_USAGE_COPY_SRC);
    for (const { name } of COMPOSE_PASSES) {
      this.ensureAllocation(name, texelBytes, HEIGHT_PASS_OUTPUT_USAGE);
    }
  }

  private ensureAllocation(
    name: AllocationName,
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

  private allocation(name: AllocationName): GpuBufferLike {
    const buffer = this.allocations.get(name);
    if (buffer === undefined) {
      throw new Error(`missing allocation for ${name}`);
    }
    return buffer;
  }

  private outputBinding(
    name: AllocationName,
    texelBytes: number,
    format: HeightPassOutputFormat,
  ): HeightPassOutputBinding {
    return {
      buffer: this.allocation(name),
      byteLength: texelBytes,
      format,
      usage: HEIGHT_PASS_OUTPUT_USAGE,
    };
  }

  // -- host packing (little-endian, offsets pinned by height-pass-wgsl.ts) --

  private packUniform(totalMaskCells: number, yOffset: number, regionEnd: number): void {
    const view = new DataView(this.uniformBytes.buffer);
    view.setUint32(0, totalMaskCells, true);
    view.setUint32(4, WORKGROUP_SIZE, true);
    view.setUint32(8, yOffset, true);
    view.setUint32(12, regionEnd, true);
  }

  /**
   * #32 pack the reused maskMeta buffer: element 0 = full-frame sentinel or
   * the partial candidate count; elements `1..1+count` = the candidate
   * ORIGINAL surface indices (zeroed on full frames); the per-mask
   * workspace byte offsets at the fixed base `1 + surfaceCount`. The buffer
   * is zero-filled BEFORE packing, so stale bytes from a larger previous
   * frame can never be read: the shaders only access element 0, elements
   * `< 1 + candidateCount`, and the current mask offsets at
   * `1 + surfaceCount + i` — every one freshly written here.
   */
  private packMaskMeta(
    offsets: readonly number[],
    surfaceCount: number,
    candidates: readonly number[] | null,
  ): void {
    const byteLength = Math.max(
      (MASK_META_CANDIDATE_BASE + surfaceCount + offsets.length) * MASK_META_STRIDE,
      MIN_PASS_ALLOCATION_BYTES,
    );
    if (this.maskMetaBytes.byteLength < byteLength) {
      this.maskMetaBytes = new Uint8Array(byteLength);
    }
    this.maskMetaLogicalBytes = byteLength;
    this.maskMetaBytes.fill(0);
    const view = new DataView(this.maskMetaBytes.buffer);
    if (candidates === null) {
      view.setUint32(0, MASK_META_FULL_SENTINEL, true);
    } else {
      view.setUint32(0, candidates.length, true);
      for (let i = 0; i < candidates.length; i++) {
        view.setUint32((MASK_META_CANDIDATE_BASE + i) * MASK_META_STRIDE, candidates[i], true);
      }
    }
    const maskBase = MASK_META_CANDIDATE_BASE + surfaceCount;
    for (let i = 0; i < offsets.length; i++) {
      view.setUint32((maskBase + i) * MASK_META_STRIDE, offsets[i], true);
    }
  }

  /**
   * #32 validate the candidate bin: a `null`/`undefined` list packs the
   * full-frame sentinel; a provided list must contain valid ORIGINAL
   * surface indices in strict ascending order (deterministic, no
   * duplicates). An EMPTY list is legal (a zero-candidate band — the
   * compose shaders write the cleared/background outputs directly).
   */
  private assertCandidates(
    candidates: readonly number[] | undefined,
    surfaceCount: number,
  ): readonly number[] | null {
    if (candidates === undefined || candidates === null) {
      return null;
    }
    let previous = -1;
    for (let i = 0; i < candidates.length; i++) {
      const index = candidates[i];
      if (!Number.isInteger(index) || index < 0 || index >= surfaceCount) {
        throw new RangeError(
          `candidate surface index ${index} out of range 0..${surfaceCount - 1}`,
        );
      }
      if (i > 0 && index <= previous) {
        throw new RangeError(
          "candidate surface indices must be strictly ascending and unique",
        );
      }
      previous = index;
    }
    if (candidates.length > surfaceCount) {
      throw new RangeError(
        `candidate count ${candidates.length} exceeds surfaceCount ${surfaceCount}`,
      );
    }
    return candidates;
  }

  // -- pipelines and bind groups --------------------------------------------

  private ensurePipelines(): CachedPipelines {
    if (this.pipelines !== null) {
      return this.pipelines;
    }
    // The full scene layout binds ALL five #24 buffers with their
    // shader-derived minimum sizes; every pipeline shares it, so every
    // compute pass consumes the five SceneUploader bindings directly.
    // Storage totals: SDF = 5 + 2 = 7; each compose pass = 5 + 3 = 8 —
    // within the spec-minimum maxStorageBuffersPerShaderStage of 8.
    const sceneLayout = this.device.createBindGroupLayout({
      label: "ukibori-height-pass-scene",
      entries: SCENE_BINDING_MIN_SIZES.map(([binding, minBindingSize]) => ({
        binding,
        visibility: COMPUTE_STAGE_VISIBILITY,
        buffer: { type: "read-only-storage", hasDynamicOffset: false, minBindingSize },
      })),
    });
    const sdfLayout = this.device.createBindGroupLayout({
      label: "ukibori-height-pass-sdf",
      entries: [
        uniformEntry(0),
        storageEntry(1, "read-only-storage", MASK_META_STRIDE),
        storageEntry(2, "storage"),
      ],
    });
    const composeLayout = this.device.createBindGroupLayout({
      label: "ukibori-height-pass-compose",
      entries: [
        uniformEntry(0),
        storageEntry(1, "read-only-storage", MASK_META_STRIDE),
        storageEntry(2, "read-only-storage"),
        storageEntry(3, "storage"),
      ],
    });
    const sdfModule = this.device.createShaderModule({
      code: MASK_SDF_WGSL,
      label: "ukibori-mask-sdf",
    });
    const composeModules = COMPOSE_PASSES.map(({ name, module }) =>
      this.device.createShaderModule({ code: module, label: `ukibori-compose-${name}` }),
    );
    const sdfPipeline = this.device.createComputePipeline({
      label: "ukibori-mask-sdf",
      layout: this.device.createPipelineLayout({
        label: "ukibori-height-pass-sdf",
        bindGroupLayouts: [sceneLayout, sdfLayout],
      }),
      compute: { module: sdfModule, entryPoint: "main" },
    });
    const composePipelineLayout = this.device.createPipelineLayout({
      label: "ukibori-height-pass-compose",
      bindGroupLayouts: [sceneLayout, composeLayout],
    });
    const composePipelines = composeModules.map((module, i) =>
      this.device.createComputePipeline({
        label: `ukibori-compose-${COMPOSE_PASSES[i].name}`,
        layout: composePipelineLayout,
        compute: { module, entryPoint: "main" },
      }),
    );
    this.pipelines = {
      sceneLayout,
      sdfLayout,
      composeLayout,
      sdfPipeline,
      composePipelines,
    };
    return this.pipelines;
  }

  private createSceneBindGroup(
    bindings: SceneBindings,
    layout: GpuBindGroupLayoutLike,
  ): GpuBindGroupLike {
    // The #24 binding snapshot is consumed DIRECTLY: the structural
    // `GpuBufferLike` -> real `GPUBuffer` cast happens here at the narrow
    // boundary (never a copy into new host/GPU buffers).
    return this.device.createBindGroup({
      label: "ukibori-height-pass-scene",
      layout,
      entries: [
        { binding: 0, resource: { buffer: bindings.header.buffer } },
        { binding: 1, resource: { buffer: bindings.surfaces.buffer } },
        { binding: 2, resource: { buffer: bindings.masks.buffer } },
        { binding: 3, resource: { buffer: bindings.maskPixels.buffer } },
        { binding: 4, resource: { buffer: bindings.materials.buffer } },
      ],
    });
  }

  private createSdfBindGroup(layout: GpuBindGroupLayoutLike): GpuBindGroupLike {
    return this.device.createBindGroup({
      label: "ukibori-height-pass-sdf",
      layout,
      entries: [
        { binding: 0, resource: { buffer: this.allocation("uniform") } },
        { binding: 1, resource: { buffer: this.allocation("maskMeta") } },
        { binding: 2, resource: { buffer: this.allocation("maskWorkspace") } },
      ],
    });
  }

  /** One bind group per compose pass; binding 3 is that pass's output. */
  private createComposeBindGroups(layout: GpuBindGroupLayoutLike): readonly GpuBindGroupLike[] {
    return COMPOSE_PASSES.map(({ name }) =>
      this.device.createBindGroup({
        label: `ukibori-height-pass-compose-${name}`,
        layout,
        entries: [
          { binding: 0, resource: { buffer: this.allocation("uniform") } },
          { binding: 1, resource: { buffer: this.allocation("maskMeta") } },
          { binding: 2, resource: { buffer: this.allocation("maskWorkspace") } },
          { binding: 3, resource: { buffer: this.allocation(name) } },
        ],
      }),
    );
  }
}

// -- helpers ----------------------------------------------------------------

function uniformEntry(binding: number): GpuBindGroupLayoutEntryLike {
  return {
    binding,
    visibility: COMPUTE_STAGE_VISIBILITY,
    buffer: {
      type: "uniform",
      hasDynamicOffset: false,
      minBindingSize: HEIGHT_PASS_PARAMS_BYTE_LENGTH,
    },
  };
}

function storageEntry(
  binding: number,
  type: string,
  minBindingSize = 0,
): GpuBindGroupLayoutEntryLike {
  return {
    binding,
    visibility: COMPUTE_STAGE_VISIBILITY,
    buffer: { type, hasDynamicOffset: false, minBindingSize },
  };
}

function ceilDiv(numerator: number, denominator: number): number {
  return Math.ceil(numerator / denominator);
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

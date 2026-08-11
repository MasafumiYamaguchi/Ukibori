import type { EncodedScene } from "./encode";
import {
  GPU_USAGE_COPY_DST,
  GPU_USAGE_COPY_SRC,
  GPU_USAGE_STORAGE,
  HEADER_SIZE,
  MATERIAL_STRIDE,
} from "./layout";
import type { GpuBufferLike, SceneBindings } from "./uploader";
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
  GpuPipelineLayoutLike,
  GpuShaderModuleLike,
  HeightPassProvenance,
  HeightPassSnapshot,
} from "./height-pass";
import type { NormalPassSnapshot } from "./normal-pass";
import type { ShadowPassSnapshot } from "./shadow-pass";
import {
  LIGHTING_OUTPUT_BYTES_PER_TEXEL,
  LIGHTING_PARAMS_BYTE_LENGTH,
  LIGHTING_PASS_WGSL,
  LIGHTING_WORKGROUP_SIZE,
} from "./lighting-pass-wgsl";

/**
 * #28 GPU material/lighting stage — a real WebGPU compute pass that
 * consumes the #26 normal field, the #25 material-id field and the #27
 * visibility field DIRECTLY (never copied into new host/GPU inputs), plus
 * the exact uploaded scene header and material table, and leaves the final
 * sRGB-encoded RGBA8 color (and the two f32 debug fields) GPU-resident for
 * #29. Normal-frame execution performs only a uniform upload and a compute
 * submission — no map, no readback.
 *
 * ## Direct bindings and the single-pass storage budget
 *
 * The pass binds exactly five read-only storage inputs — sceneHeader (the
 * #24 uploader binding), materials (the #24 uploader binding), materialId
 * (the #25 output), inNormal (the #26 output), inVisibility (the #27
 * output) — plus three output storage buffers (diffuse, specular, color):
 * exactly the WebGPU spec-minimum storage budget of eight, plus the uniform
 * params binding. `maxStorageBuffersPerShaderStage >= 8` is validated
 * before any device call.
 *
 * ## Provenance / structural checks before ANY device call
 *
 * In order, before any allocation/write/pipeline/bind-group/encoder call:
 *
 * 1. strict byte-level `validateEncodedScene` (rejected with the collected
 *    errors)
 * 2. `bindings.provenance` must be the exact `scene.bytes` object (O(1)
 *    identity), and `bindings.sceneByteLength` must equal the header total
 * 3. the header binding must expose exactly `HEADER_SIZE` logical bytes and
 *    cover them physically; the materials section byte length must equal
 *    `materialCount * MATERIAL_STRIDE` and its buffer must cover at least
 *    the one-record ABI floor (an empty logical material table binds
 *    `MATERIAL_STRIDE` and the shader never reads it)
 * 4. materialId/normal/visibility must share the EXACT per-HeightPass-
 *    dispatch provenance object (propagated through the NormalPass and
 *    ShadowPass snapshots by the public helpers), whose `sceneBytes` must
 *    be the exact `scene.bytes`; this rejects FOREIGN scenes and MIXED
 *    fields from separate dispatches of the same scene before any device
 *    call. Synthetic test-only inputs may use the documented provenance
 *    seam (a frozen `HeightPassProvenance` sharing the encoded scene).
 * 5. render width/height positive integers; the render texel count must
 *    fit safe integers and u32 (it is used by in-shader u32 products)
 * 6. the three field bindings must match the header extent, their formats
 *    (`u32` for materialId, `f32` for normal/visibility), channel counts
 *    (normal = 3, others = 1), logical byte lengths (normal = 12 * texels,
 *    others = 4 * texels) and STORAGE usage, and their buffer sizes must
 *    cover the logical bytes
 * 7. workgroup-size limits (`maxComputeWorkgroupSizeX`,
 *    `maxComputeInvocationsPerWorkgroup`), `maxStorageBuffersPerShaderStage
 *    >= 8` (when reported) and the dispatch count against
 *    `maxComputeWorkgroupsPerDimension` (default 65535)
 * 8. every explicit storage binding range is bounded by
 *    `maxStorageBufferBindingSize`, and pass-owned allocations are also
 *    bounded by `maxBufferSize`
 *
 * ## Effective ambient sanitization (documented and pinned by tests)
 *
 * `sanitizeAmbient` maps the option to a finite f32 value in [0, 1]:
 *
 * - non-finite raw values (NaN, +/-Infinity) fall back to the default 0.08
 * - raw finite values that round to a non-finite f32 (`1e300` -> Infinity)
 *   fall back to the default
 * - representable finite values are rounded to f32 (`Math.fround`) and
 *   CLAMPED into [0, 1] (negative -> 0, above 1 -> 1), matching the CPU
 *   oracle's `clamp(sanitizeFinite(ambient, 0.08), 0, 1)` for every f32
 *   representable value
 *
 * Changing ambient rewrites the bounded uniform and redispatches while
 * reusing every allocation and the cached pipeline. The effective ambient
 * is exposed in the pass snapshot.
 *
 * ## Output
 *
 * Three tightly packed row-major outputs, 4 logical bytes per texel:
 * diffuse (scalar f32), specular (scalar f32) and color (packed RGBA8 —
 * byte order R, G, B, A in little-endian readback; alpha 255). All
 * production outputs are `STORAGE | COPY_SRC | COPY_DST`, never mapped, and
 * exposed through the stable read-only snapshot for #29.
 *
 * ## Structural device interface
 *
 * The class drives the same narrow structural `GpuComputeDeviceLike` mirror
 * as `HeightPass` (the real `GPUDevice` cast is the only boundary; the Node
 * test mock implements the same surface, so no fabricated WebGPU methods
 * exist).
 */
export const LIGHTING_PASS_OUTPUT_USAGE =
  GPU_USAGE_STORAGE | GPU_USAGE_COPY_SRC | GPU_USAGE_COPY_DST;

/** Largest u32 value; the texel count used by in-shader products must fit it. */
const U32_MAX = 0xffffffff;

/** Default `maxStorageBufferBindingSize` / `maxBufferSize` (spec minimum). */
const DEFAULT_MAX_STORAGE_BYTES = 256 * 1024 * 1024;

/** Default `maxComputeWorkgroupsPerDimension` (spec minimum). */
const DEFAULT_MAX_WORKGROUPS = 65535;

/** Smallest legal allocation for pass-owned buffers. */
const MIN_PASS_ALLOCATION_BYTES = 16;

/** Default ambient fill strength (same constant as lighting.ts). */
export const DEFAULT_AMBIENT = 0.08;

/** Host binding view of a #25/#26/#27 scalar/vector field (narrow type). */
export interface LightingFieldBinding {
  /** the EXACT #25/#26/#27 output buffer (never a copy) */
  readonly buffer: GpuBufferLike;
  /** logical field bytes (normal = 12 * texels, materialId/visibility = 4 * texels) */
  readonly byteLength: number;
  /** #25 u32 material ids, #26/#27 f32 fields */
  readonly format: "f32" | "u32";
  /** normal has 3 tightly packed scalar channels; materialId/visibility have 1 */
  readonly channels: 1 | 3;
  /** must include STORAGE (the shader reads the buffer as storage) */
  readonly usage: number;
  /** render extent width (texels) */
  readonly width: number;
  /** render extent height (texels) */
  readonly height: number;
  /**
   * O(1) identity of the successful #25 dispatch this field came from.
   * Every field in one LightingPass input must share this exact object; its
   * `sceneBytes` must also match the dispatched encoded scene. Synthetic
   * test-only inputs may construct a frozen `HeightPassProvenance` over the
   * encoded scene (the documented provenance seam).
   */
  readonly provenance: HeightPassProvenance;
}

/** Lighting options consumed by the pass (ambient only, sanitized like the oracle). */
export interface LightingPassOptions {
  /** ambient fill strength (default 0.08); sanitized like the CPU oracle */
  readonly ambient?: number;
}

export interface LightingPassInput {
  /** the EXACT encoded scene (bytes provenance + header, strict-validated) */
  readonly scene: EncodedScene;
  /** the EXACT SceneUploader bindings whose provenance is `scene.bytes` */
  readonly bindings: SceneBindings;
  /** #25 material-id binding, consumed DIRECTLY */
  readonly materialId: LightingFieldBinding;
  /** #26 normal binding, consumed DIRECTLY */
  readonly normal: LightingFieldBinding;
  /** #27 visibility binding, consumed DIRECTLY */
  readonly visibility: LightingFieldBinding;
  /** CPU-compatible lighting options; ambient sanitized like the oracle */
  readonly options?: LightingPassOptions;
}

/** Stable read-only output binding for #29 presentation. */
export interface LightingOutputBinding {
  /** GPU allocation (never undefined after the first dispatch) */
  readonly buffer: GpuBufferLike;
  /** logical bytes == 4 * width * height (tightly packed per texel) */
  readonly byteLength: number;
  /** f32 for diffuse/specular, rgba8 for the packed color */
  readonly format: "f32" | "rgba8";
  /** 1 scalar channel (diffuse/specular) or 4 packed bytes (color) */
  readonly channels: 1 | 4;
  /** `STORAGE | COPY_SRC | COPY_DST` */
  readonly usage: number;
}

export interface LightingPassLastDispatch {
  readonly renderWidth: number;
  readonly renderHeight: number;
  /** ceil(texels / LIGHTING_WORKGROUP_SIZE) */
  readonly workgroupCountX: number;
}

/** Stable read-only snapshot of the lighting outputs after the last dispatch. */
export interface LightingPassSnapshot {
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
  readonly workgroupSize: number;
  /** the effective (sanitized, f32-rounded, clamped) ambient that ran */
  readonly ambient: number;
  readonly diffuse: LightingOutputBinding;
  readonly specular: LightingOutputBinding;
  readonly color: LightingOutputBinding;
  readonly lastDispatch: LightingPassLastDispatch;
  /**
   * The per-HeightPass-dispatch provenance propagated from the #26 normal
   * binding (#29): the presentation stage requires every field to share
   * this exact token so foreign/mixed fields are rejected before any
   * presentation-device/context call.
   */
  readonly provenance: HeightPassProvenance;
}

export interface LightingPassDispatchStats {
  readonly newAllocations: number;
  readonly allocationCount: number;
  readonly totalAllocationBytes: number;
  readonly workgroupCountX: number;
}

/**
 * Sanitize the ambient option to the effective f32 value packed to the GPU
 * (see class docs for the policy). Defaults stay CPU-compatible: `f32(0.08)`
 * (the f32-packed form of the CPU default, so the packed uniform, the
 * snapshot and the CPU oracle fed with the effective ambient always agree).
 * The value is judged AFTER f32 rounding (`Math.fround`): non-finite raw
 * values and values that round to a non-finite f32 fall back to `f32(0.08)`;
 * representable values are rounded and clamped into [0, 1].
 */
export function sanitizeAmbient(ambient: number | undefined): number {
  const fallback = Math.fround(DEFAULT_AMBIENT);
  if (typeof ambient !== "number" || !Number.isFinite(ambient)) {
    return fallback;
  }
  const rounded = Math.fround(ambient);
  if (!Number.isFinite(rounded)) {
    return fallback;
  }
  return Math.min(Math.max(rounded, 0), 1);
}

/**
 * Build the narrow material-id binding consumed by `LightingPass` from the
 * #25 output snapshot — the exact `materialId` buffer, the snapshot render
 * extent, and its per-dispatch O(1) provenance token.
 */
export function lightingMaterialIdBindingFromHeightPass(
  snapshot: HeightPassSnapshot,
): LightingFieldBinding {
  const binding = snapshot.outputs.materialId;
  return {
    buffer: binding.buffer,
    byteLength: binding.byteLength,
    format: binding.format as "u32",
    channels: 1,
    usage: binding.usage,
    width: snapshot.width,
    height: snapshot.height,
    provenance: snapshot.provenance,
  };
}

/**
 * Build the narrow normal binding from the #26 snapshot. Requires the
 * HeightPass provenance propagated into the NormalPass snapshot (the normal
 * pass must have been dispatched from a #25 snapshot, or the synthetic
 * provenance seam must be used explicitly); throws otherwise.
 */
export function lightingNormalBindingFromNormalPass(
  snapshot: NormalPassSnapshot,
): LightingFieldBinding {
  if (snapshot.provenance === null) {
    throw new Error(
      "normal pass snapshot has no HeightPass provenance: dispatch the normal " +
        "pass from a HeightPass snapshot or use the documented synthetic " +
        "provenance seam",
    );
  }
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
 * Build the narrow visibility binding from the #27 snapshot — the exact
 * visibility buffer, the snapshot render extent and the propagated
 * per-HeightPass-dispatch provenance token.
 */
export function lightingVisibilityBindingFromShadowPass(
  snapshot: ShadowPassSnapshot,
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

type LightingAllocationName = "uniform" | "outDiffuse" | "outSpecular" | "outColor";

interface CachedLightingPipeline {
  layout: GpuBindGroupLayoutLike;
  pipelineLayout: GpuPipelineLayoutLike;
  pipeline: GpuComputePipelineLike;
  module: GpuShaderModuleLike;
}

export class LightingPass {
  private readonly allocations = new Map<LightingAllocationName, GpuBufferLike>();
  private readonly allocationSizes = new Map<LightingAllocationName, number>();
  private readonly uniformBytes = new Uint8Array(LIGHTING_PARAMS_BYTE_LENGTH);
  private newAllocations = 0;
  private lastDispatch: LightingPassLastDispatch | null = null;
  private lastDpr = 0;
  private lastAmbient = DEFAULT_AMBIENT;
  private lastProvenance: HeightPassProvenance | null = null;
  private cached: CachedLightingPipeline | null = null;

  constructor(private readonly device: GpuComputeDeviceLike) {}

  /**
   * Evaluate the material/lighting model for one #25/#26/#27 field triple
   * bound to the exact encoded scene/upload. Validation, limits and
   * allocation bounds all run BEFORE any device call; execution then
   * performs only a uniform upload and one compute submission (no map, no
   * readback). Updating ambient reuses the same input/output allocations:
   * it only re-packs the bounded uniform and reruns the pass.
   */
  dispatch(input: LightingPassInput): LightingPassDispatchStats {
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
    this.assertHeaderSection(input.bindings);
    this.assertMaterialsSection(header.materialCount, input.bindings);
    this.assertExtent(header, scene.bytes, input);
    const texelCount = header.renderWidth * header.renderHeight;
    const workgroupCountX = Math.ceil(texelCount / LIGHTING_WORKGROUP_SIZE);
    this.assertDeviceLimits(workgroupCountX);
    const fieldBytes = texelCount * 4;
    const normalBytes = texelCount * 12; // tightly packed f32 xyz triples
    const materialsBindingBytes = Math.max(
      header.materialCount * MATERIAL_STRIDE,
      MATERIAL_STRIDE,
    );
    this.assertStorageBindingsWithinLimit([
      ["scene header input", HEADER_SIZE],
      ["materials input", materialsBindingBytes],
      ["materialId input", fieldBytes],
      ["normal input", normalBytes],
      ["visibility input", fieldBytes],
      ["diffuse output", fieldBytes],
      ["specular output", fieldBytes],
      ["color output", fieldBytes],
    ]);
    this.assertAllocationWithinLimits(LIGHTING_PARAMS_BYTE_LENGTH, "params uniform");
    this.assertAllocationWithinLimits(fieldBytes, "diffuse/specular/color output");

    const ambient = sanitizeAmbient(input.options?.ambient);
    this.ensureAllocation(
      "uniform",
      LIGHTING_PARAMS_BYTE_LENGTH,
      GPU_USAGE_UNIFORM | GPU_USAGE_COPY_DST,
    );
    this.ensureAllocation("outDiffuse", fieldBytes, LIGHTING_PASS_OUTPUT_USAGE);
    this.ensureAllocation("outSpecular", fieldBytes, LIGHTING_PASS_OUTPUT_USAGE);
    this.ensureAllocation("outColor", fieldBytes, LIGHTING_PASS_OUTPUT_USAGE);
    this.packUniform(ambient);
    const uniform = this.allocation("uniform");
    this.device.queue.writeBuffer(uniform, 0, this.uniformBytes);

    const cached = this.ensurePipeline();
    const group = this.device.createBindGroup({
      label: "ukibori-lighting-pass",
      layout: cached.layout,
      entries: [
        {
          binding: 0,
          resource: { buffer: uniform, size: LIGHTING_PARAMS_BYTE_LENGTH },
        },
        // #24/#25/#26/#27 fields are consumed DIRECTLY (narrow structural
        // casts at this boundary, never copies into new input allocations).
        {
          binding: 1,
          resource: { buffer: input.bindings.header.buffer, size: HEADER_SIZE },
        },
        {
          binding: 2,
          resource: {
            buffer: input.bindings.materials.buffer,
            size: materialsBindingBytes,
          },
        },
        {
          binding: 3,
          resource: { buffer: input.materialId.buffer, size: fieldBytes },
        },
        {
          binding: 4,
          resource: { buffer: input.normal.buffer, size: normalBytes },
        },
        {
          binding: 5,
          resource: { buffer: input.visibility.buffer, size: fieldBytes },
        },
        {
          binding: 6,
          resource: { buffer: this.allocation("outDiffuse"), size: fieldBytes },
        },
        {
          binding: 7,
          resource: { buffer: this.allocation("outSpecular"), size: fieldBytes },
        },
        {
          binding: 8,
          resource: { buffer: this.allocation("outColor"), size: fieldBytes },
        },
      ],
    });

    const encoder = this.device.createCommandEncoder({ label: "ukibori-lighting-pass" });
    const pass = encoder.beginComputePass();
    pass.setPipeline(cached.pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(workgroupCountX);
    pass.end();
    this.device.queue.submit([encoder.finish()]);

    this.lastDispatch = {
      renderWidth: header.renderWidth,
      renderHeight: header.renderHeight,
      workgroupCountX,
    };
    this.lastDpr = header.dpr;
    this.lastAmbient = ambient;
    this.lastProvenance = input.normal.provenance;

    const stats: LightingPassDispatchStats = {
      newAllocations: this.newAllocations,
      allocationCount: this.allocations.size,
      totalAllocationBytes: sumOf(this.allocationSizes),
      workgroupCountX,
    };
    this.newAllocations = 0;
    return stats;
  }

  /** Stable read-only snapshot; throws before the first successful dispatch. */
  getSnapshot(): LightingPassSnapshot {
    if (this.lastDispatch === null || this.lastProvenance === null) {
      throw new Error("no dispatch: dispatch() has not completed or dispose() was called");
    }
    const texelCount = this.lastDispatch.renderWidth * this.lastDispatch.renderHeight;
    const fieldBytes = texelCount * LIGHTING_OUTPUT_BYTES_PER_TEXEL;
    const scalar = (name: LightingAllocationName): LightingOutputBinding => ({
      buffer: this.allocation(name),
      byteLength: fieldBytes,
      format: "f32",
      channels: 1,
      usage: LIGHTING_PASS_OUTPUT_USAGE,
    });
    return {
      width: this.lastDispatch.renderWidth,
      height: this.lastDispatch.renderHeight,
      dpr: this.lastDpr,
      workgroupSize: LIGHTING_WORKGROUP_SIZE,
      ambient: this.lastAmbient,
      diffuse: scalar("outDiffuse"),
      specular: scalar("outSpecular"),
      color: {
        buffer: this.allocation("outColor"),
        byteLength: fieldBytes,
        format: "rgba8",
        channels: 4,
        usage: LIGHTING_PASS_OUTPUT_USAGE,
      },
      lastDispatch: this.lastDispatch,
      provenance: this.lastProvenance,
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
    this.lastDpr = 0;
    this.lastAmbient = DEFAULT_AMBIENT;
    this.lastProvenance = null;
  }

  // -- validation (all BEFORE any device call) ------------------------------

  private assertHeaderSection(bindings: SceneBindings): void {
    if (bindings.header.byteLength !== HEADER_SIZE) {
      throw new Error(
        `scene header binding byteLength ${bindings.header.byteLength} != expected ${HEADER_SIZE}`,
      );
    }
    if (bindings.header.buffer.size < HEADER_SIZE) {
      throw new Error(
        `scene header buffer size ${bindings.header.buffer.size} < required ${HEADER_SIZE}`,
      );
    }
  }

  private assertMaterialsSection(materialCount: number, bindings: SceneBindings): void {
    const expectedByteLength = materialCount * MATERIAL_STRIDE;
    if (!Number.isSafeInteger(expectedByteLength) || expectedByteLength < 0) {
      throw new Error(
        `scene materials section byte length ${expectedByteLength} is invalid`,
      );
    }
    if (bindings.materials.byteLength !== expectedByteLength) {
      throw new Error(
        `scene materials binding byteLength ${bindings.materials.byteLength} != expected ${expectedByteLength}`,
      );
    }
    // The WGSL layout has a one-record minimum even for an empty logical
    // section; SceneUploader allocates the same ABI floor and the shader
    // never reads it (materialId NO_OWNER/fallback paths only).
    const required = Math.max(expectedByteLength, MATERIAL_STRIDE);
    if (bindings.materials.buffer.size < required) {
      throw new Error(
        `scene materials buffer size ${bindings.materials.buffer.size} < required ${required}`,
      );
    }
  }

  private assertExtent(
    header: { renderWidth: number; renderHeight: number; dpr: number; materialCount: number },
    sceneBytes: Uint8Array,
    input: LightingPassInput,
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
    const provenance = input.normal.provenance;
    if (
      input.materialId.provenance !== provenance ||
      input.visibility.provenance !== provenance
    ) {
      throw new Error(
        "mixed HeightPass provenance: materialId, normal and visibility must come " +
          "from one successful HeightPass dispatch",
      );
    }
    if (provenance.sceneBytes !== sceneBytes) {
      throw new Error(
        "lighting field provenance does not match the dispatched scene: consume " +
          "NormalPass/ShadowPass snapshots produced from this exact EncodedScene",
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
      ["materialId", input.materialId],
      ["normal", input.normal],
      ["visibility", input.visibility],
    ] as const) {
      if (binding.width !== header.renderWidth || binding.height !== header.renderHeight) {
        throw new Error(
          `${name} binding extent ${binding.width}x${binding.height} != render extent ` +
            `${header.renderWidth}x${header.renderHeight}`,
        );
      }
      const expectedBytes = texelCount * (name === "normal" ? 12 : 4);
      if (binding.byteLength !== expectedBytes) {
        throw new Error(
          `${name} binding byteLength ${binding.byteLength} != expected ${expectedBytes} ` +
            `(${header.renderWidth}x${header.renderHeight} field)`,
        );
      }
      const expectedFormat = name === "materialId" ? "u32" : "f32";
      if (binding.format !== expectedFormat) {
        throw new Error(
          `${name} binding format ${String(binding.format)} != ${expectedFormat}`,
        );
      }
      const expectedChannels = name === "normal" ? 3 : 1;
      if (binding.channels !== expectedChannels) {
        throw new Error(
          `${name} binding channels ${binding.channels} != ${expectedChannels}`,
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
    if (LIGHTING_WORKGROUP_SIZE > maxWorkgroupX || LIGHTING_WORKGROUP_SIZE > maxInvocations) {
      throw new Error(
        `workgroup size ${LIGHTING_WORKGROUP_SIZE} exceeds device limits ` +
          `(maxComputeWorkgroupSizeX ${maxWorkgroupX}, ` +
          `maxComputeInvocationsPerWorkgroup ${maxInvocations})`,
      );
    }
    const maxStorage = limits.maxStorageBuffersPerShaderStage;
    if (
      typeof maxStorage === "number" &&
      Number.isFinite(maxStorage) &&
      maxStorage > 0 &&
      maxStorage < 8
    ) {
      throw new Error(
        `maxStorageBuffersPerShaderStage ${maxStorage} < 8: the lighting pass needs ` +
          `exactly 8 storage bindings per stage (5 read-only + 3 outputs)`,
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

  // -- allocations ----------------------------------------------------------

  private ensureAllocation(
    name: LightingAllocationName,
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

  private allocation(name: LightingAllocationName): GpuBufferLike {
    const buffer = this.allocations.get(name);
    if (buffer === undefined) {
      throw new Error(`missing allocation for ${name}`);
    }
    return buffer;
  }

  // -- host packing (little-endian, offsets pinned by lighting-pass-wgsl.ts) --

  private packUniform(ambient: number): void {
    const view = new DataView(this.uniformBytes.buffer);
    view.setFloat32(0, ambient, true);
    view.setUint32(4, LIGHTING_WORKGROUP_SIZE, true);
    view.setUint32(8, 0, true);
    view.setUint32(12, 0, true);
  }

  // -- pipeline and bind group ----------------------------------------------

  private ensurePipeline(): CachedLightingPipeline {
    if (this.cached !== null) {
      return this.cached;
    }
    // Explicit layouts only (never layout: "auto"). Storage count per
    // stage: 5 read-only + 3 outputs = 8, exactly the spec-minimum
    // maxStorageBuffersPerShaderStage (the uniform does not count).
    const layout = this.device.createBindGroupLayout({
      label: "ukibori-lighting-pass",
      entries: [
        {
          binding: 0,
          visibility: COMPUTE_STAGE_VISIBILITY,
          buffer: {
            type: "uniform",
            hasDynamicOffset: false,
            minBindingSize: LIGHTING_PARAMS_BYTE_LENGTH,
          },
        },
        {
          binding: 1,
          visibility: COMPUTE_STAGE_VISIBILITY,
          buffer: {
            type: "read-only-storage",
            hasDynamicOffset: false,
            minBindingSize: HEADER_SIZE, // the full scene header
          },
        },
        {
          binding: 2,
          visibility: COMPUTE_STAGE_VISIBILITY,
          buffer: {
            type: "read-only-storage",
            hasDynamicOffset: false,
            minBindingSize: MATERIAL_STRIDE, // one MaterialRecord floor
          },
        },
        {
          binding: 3,
          visibility: COMPUTE_STAGE_VISIBILITY,
          buffer: {
            type: "read-only-storage",
            hasDynamicOffset: false,
            minBindingSize: 4, // at least one u32 material-id texel
          },
        },
        {
          binding: 4,
          visibility: COMPUTE_STAGE_VISIBILITY,
          buffer: {
            type: "read-only-storage",
            hasDynamicOffset: false,
            minBindingSize: 12, // one tightly packed xyz normal triple
          },
        },
        {
          binding: 5,
          visibility: COMPUTE_STAGE_VISIBILITY,
          buffer: {
            type: "read-only-storage",
            hasDynamicOffset: false,
            minBindingSize: 4, // at least one f32 visibility texel
          },
        },
        {
          binding: 6,
          visibility: COMPUTE_STAGE_VISIBILITY,
          buffer: {
            type: "storage",
            hasDynamicOffset: false,
            minBindingSize: LIGHTING_OUTPUT_BYTES_PER_TEXEL, // one f32 scalar
          },
        },
        {
          binding: 7,
          visibility: COMPUTE_STAGE_VISIBILITY,
          buffer: {
            type: "storage",
            hasDynamicOffset: false,
            minBindingSize: LIGHTING_OUTPUT_BYTES_PER_TEXEL, // one f32 scalar
          },
        },
        {
          binding: 8,
          visibility: COMPUTE_STAGE_VISIBILITY,
          buffer: {
            type: "storage",
            hasDynamicOffset: false,
            minBindingSize: LIGHTING_OUTPUT_BYTES_PER_TEXEL, // one packed RGBA8
          },
        },
      ],
    });
    const module = this.device.createShaderModule({
      code: LIGHTING_PASS_WGSL,
      label: "ukibori-lighting-pass",
    });
    const pipelineLayout = this.device.createPipelineLayout({
      label: "ukibori-lighting-pass",
      bindGroupLayouts: [layout],
    });
    const pipeline = this.device.createComputePipeline({
      label: "ukibori-lighting-pass",
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

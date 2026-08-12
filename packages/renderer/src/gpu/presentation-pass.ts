import { GPU_USAGE_COPY_DST, GPU_USAGE_STORAGE, HEADER_SIZE } from "./layout";
import type { GpuBufferLike } from "./uploader";
import type {
  GpuBindGroupEntryLike,
  GpuBindGroupLayoutEntryLike,
  GpuBindGroupLayoutLike,
  GpuBindGroupLike,
  GpuPipelineLayoutLike,
  GpuShaderModuleLike,
  HeightPassProvenance,
  HeightPassSnapshot,
} from "./height-pass";
import type { LightingPassSnapshot } from "./lighting-pass";
import type { ShadowPassSnapshot } from "./shadow-pass";
import {
  PRESENTATION_PARAMS_BYTE_LENGTH,
  PRESENTATION_PASS_WGSL,
} from "./presentation-pass-wgsl";
import {
  compositeShadowAlphaByte,
  sanitizeCompositeOptions,
} from "./composite";
import type { CompositeOptions, EffectiveCompositeOptions } from "./composite";

/**
 * #29 GPU presentation stage — the thin final stage that presents the exact
 * #28 output directly to a real `GPUCanvasContext` without a GPU-to-CPU
 * readback or CPU bitmap upload.
 *
 * ## Direct bindings (never copied, never read back)
 *
 * `present()` consumes three exact GPU buffers DIRECTLY:
 *
 * - the #28 packed RGBA8 `color` field (`LightingPassSnapshot.color`)
 * - the #25 u32 `objectId` field (`HeightPassSnapshot.outputs.objectId`)
 * - the #27 f32 `visibility` field (`ShadowPassSnapshot.output`)
 *
 * They are bound as read-only storage to the fragment stage of one
 * fullscreen-triangle render pipeline. The three fields must share the
 * EXACT per-HeightPass-dispatch provenance object (propagated by the
 * public helpers through the NormalPass/ShadowPass/LightingPass snapshots)
 * and the exact same width/height/DPR; foreign or mixed fields are rejected
 * before any presentation-device/context call.
 *
 * ## Strict validation before ANY device/context call
 *
 * In order, before any allocation, uniform write, pipeline, bind-group,
 * `configure()` or `getCurrentTexture()` call:
 *
 * 1. positive integer render extent; render texel count must fit safe
 *    integers and u32 (it is used by the in-shader u32 index product)
 * 2. shared provenance token + matching width/height/DPR across all three
 *    fields
 * 3. formats (`rgba8` for color with 4 channels, `u32` objectId and `f32`
 *    visibility with 1 channel), logical byte lengths (`4 * texels` each),
 *    STORAGE usage and buffer coverage of the logical bytes
 * 4. canvas backing-store dimensions (`context.canvas.width/height`) must
 *    equal the render extent — the canvas is resized by the orchestrator
 *    before presentation, so a stale or foreign backing store is rejected
 * 5. the supplied `canvasFormat` (resolved by the caller from
 *    `navigator.gpu.getPreferredCanvasFormat()` at the real API boundary)
 *    must be an 8-bit RGBA/BGRA format (`rgba8unorm` or `bgra8unorm`)
 * 6. device limits: every explicit storage binding range vs
 *    `maxStorageBufferBindingSize`, the uniform allocation vs
 *    `maxUniformBufferBindingSize`/`maxBufferSize`
 *
 * ## Canvas configuration and per-frame behavior
 *
 * - The context is configured with the owning device, the supplied 8-bit
 *   format, `GPUTextureUsage.RENDER_ATTACHMENT`, `alphaMode:
 *   "premultiplied"` and `colorSpace: "srgb"`. Test/debug mode (`debug:
 *   true` in the input) additionally requests `COPY_SRC`; the default
 *   production configuration never exposes a readback helper.
 * - Configuration is REUSED while the CONTEXT IDENTITY, device, format and
 *   debug usage remain unchanged (one `configurationGeneration` per actual
 *   `configure()`). A different context never skips `configure()`; switching
 *   contexts explicitly unconfigures the previous one. Backing-store resize
 *   invalidates the old current texture; the next present validates the new
 *   size and acquires a fresh texture. The pass never retains a current
 *   texture/view across frames.
 * - One render pass against `context.getCurrentTexture().createView()`,
 *   cleared to transparent black, pipeline/bind group set, 3 vertices
 *   drawn, ended, finished and submitted. No intermediate texture exists
 *   in the normal path.
 * - The render pipeline is cached per canvas target format (explicit
 *   bind-group/pipeline layouts only, never `layout: "auto"`); one
 *   reusable/growing uniform allocation hosts the packed params.
 *
 * ## Device loss
 *
 * `device.lost` is tracked; once lost, `present()`/`getSnapshot()` reject
 * without touching a stale context or submitting more work. `dispose()`
 * unconfigures the context, destroys only owned allocations and is
 * idempotent. #29 recovery is explicit construction of a fresh pipeline
 * with a fresh device (#31 owns automatic retained-resource recovery).
 *
 * ## Structural device interface
 *
 * The class drives the same narrow structural mirror pattern as the compute
 * passes: `GpuPresentationDeviceLike` is a subset of the real `GPUDevice`
 * surface used here (the real cast happens at the harness boundary; the
 * Node test mock implements the same surface, so no fabricated WebGPU
 * methods exist).
 */

/** `GPUShaderStage.FRAGMENT` spec bit value (0x1=VERTEX, 0x2=FRAGMENT, 0x4=COMPUTE). */
export const FRAGMENT_STAGE_VISIBILITY = 0x2;

/** `GPUTextureUsage.RENDER_ATTACHMENT` spec bit value (usable in Node tests). */
export const GPU_USAGE_RENDER_ATTACHMENT = 0x10;
/** GPUTextureUsage.COPY_SRC. Texture and buffer usage bit values differ. */
export const GPU_TEXTURE_USAGE_COPY_SRC = 0x1;

/** Largest u32 value; the texel count used by the in-shader index product must fit it. */
const U32_MAX = 0xffffffff;

/** Default `maxStorageBufferBindingSize` / `maxBufferSize` (spec minimum). */
const DEFAULT_MAX_STORAGE_BYTES = 256 * 1024 * 1024;

/** Default `maxUniformBufferBindingSize` (spec minimum). */
const DEFAULT_MAX_UNIFORM_BYTES = 16 * 1024;

/** Smallest legal allocation for pass-owned buffers. */
const MIN_PASS_ALLOCATION_BYTES = 16;

/** The only supported 8-bit canvas target formats (browser-preferred). */
const CANVAS_FORMATS = ["rgba8unorm", "bgra8unorm"] as const;
export type Canvas8BitFormat = (typeof CANVAS_FORMATS)[number];

/** The fixed canvas alpha mode / color space of the #29 contract. */
export const PRESENTATION_ALPHA_MODE = "premultiplied" as const;
export const PRESENTATION_COLOR_SPACE = "srgb" as const;

// ---------------------------------------------------------------------------
// Structural device / context surface (see class docs)
// ---------------------------------------------------------------------------

export interface GpuRenderPipelineLike {
  readonly label?: string;
}

export interface GpuTextureViewLike {
  readonly label?: string;
}

export interface GpuTextureLike {
  readonly width: number;
  readonly height: number;
  createView(): GpuTextureViewLike;
}

export interface GpuRenderPassEncoderLike {
  setPipeline(pipeline: GpuRenderPipelineLike): void;
  setBindGroup(index: number, bindGroup: GpuBindGroupLike): void;
  draw(vertexCount: number): void;
  end(): void;
}

export interface GpuPresentationLimitsLike {
  readonly maxStorageBufferBindingSize: number;
  readonly maxBufferSize?: number;
  readonly maxUniformBufferBindingSize?: number;
}

export interface GpuPresentationEncoderLike {
  beginRenderPass(desc: {
    readonly label?: string;
    readonly colorAttachments: readonly [
      {
        readonly view: GpuTextureViewLike;
        readonly clearValue: { readonly r: number; readonly g: number; readonly b: number; readonly a: number };
        readonly loadOp: string;
        readonly storeOp: string;
      },
    ];
  }): GpuRenderPassEncoderLike;
  finish(): { readonly label?: string };
}

export interface GpuCanvasConfigurationLike {
  readonly device: GpuPresentationDeviceLike;
  readonly format: string;
  readonly usage: number;
  readonly alphaMode: string;
  readonly colorSpace: string;
}

export interface GpuCanvasContextLike {
  /**
   * the owning canvas backing store (dimensions validated before
   * configure/acquire; writable so the #29 orchestrator can resize it to the
   * encoded render extent)
   */
  readonly canvas: { width: number; height: number };
  configure(desc: GpuCanvasConfigurationLike): void;
  unconfigure(): void;
  getCurrentTexture(): GpuTextureLike;
}

export interface GpuPresentationDeviceLike {
  readonly limits: GpuPresentationLimitsLike;
  /** resolves on device loss (never rejects; the pass fails closed on it) */
  readonly lost: Promise<unknown>;
  readonly queue: {
    writeBuffer(
      buffer: GpuBufferLike,
      dstByteOffset: number,
      source: Uint8Array,
      srcOffset?: number,
      srcSize?: number,
    ): void;
    submit(commandBuffers: readonly { readonly label?: string }[]): void;
  };
  createBuffer(desc: { readonly size: number; readonly usage: number; readonly label?: string }): GpuBufferLike;
  createShaderModule(desc: { readonly code: string; readonly label?: string }): GpuShaderModuleLike;
  createRenderPipeline(desc: {
    readonly layout: GpuPipelineLayoutLike;
    readonly vertex: { readonly module: GpuShaderModuleLike; readonly entryPoint: string };
    readonly fragment: {
      readonly module: GpuShaderModuleLike;
      readonly entryPoint: string;
      readonly targets: readonly { readonly format: string; readonly label?: string }[];
    };
    readonly primitive?: { readonly topology: string };
    readonly label?: string;
  }): GpuRenderPipelineLike;
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
  createCommandEncoder(desc?: { readonly label?: string }): GpuPresentationEncoderLike;
}

// ---------------------------------------------------------------------------
// Inputs, snapshot and stats
// ---------------------------------------------------------------------------

/**
 * Narrow host view of one presentation field: the EXACT #25/#27/#28 output
 * buffer (never a copy), its logical extent/DPR, and the shared
 * per-HeightPass-dispatch provenance token.
 */
export interface PresentationInputBinding {
  /** the EXACT output buffer (never a copy or replacement upload) */
  readonly buffer: GpuBufferLike;
  /** logical field bytes == 4 * width * height for all three fields */
  readonly byteLength: number;
  /** #28 packed color is "rgba8" (4 channels); objectId "u32" / visibility "f32" (1) */
  readonly format: "rgba8" | "u32" | "f32";
  /** 4 packed RGBA bytes (color) or 1 scalar (objectId/visibility) */
  readonly channels: 1 | 4;
  /** must include STORAGE (the fragment shader reads the buffer as storage) */
  readonly usage: number;
  /** render extent width (texels) */
  readonly width: number;
  /** render extent height (texels) */
  readonly height: number;
  /** render DPR (must match the other fields and the provenance) */
  readonly dpr: number;
  /**
   * O(1) identity of the successful #25 dispatch this field came from.
   * All three presentation fields must share this exact object.
   */
  readonly provenance: HeightPassProvenance;
}

export interface PresentationPassInput {
  /** the #28 packed RGBA8 color binding, consumed DIRECTLY */
  readonly color: PresentationInputBinding;
  /** the #25 u32 object-id binding, consumed DIRECTLY */
  readonly objectId: PresentationInputBinding;
  /** the #27 f32 visibility binding, consumed DIRECTLY */
  readonly visibility: PresentationInputBinding;
  /** the owning canvas context (configured/presented by this pass) */
  readonly context: GpuCanvasContextLike;
  /**
   * The browser-preferred canvas format, resolved ONCE at the real API
   * boundary via `navigator.gpu.getPreferredCanvasFormat()` and validated
   * here to be an 8-bit RGBA/BGRA format. The pass never calls
   * `navigator.gpu` or a fabricated context method itself.
   */
  readonly canvasFormat: Canvas8BitFormat;
  /** CPU-compatible composite options; sanitized like the CPU compositor */
  readonly options?: CompositeOptions;
  /**
   * Test-only: additionally request `COPY_SRC` on the canvas texture
   * usage so the harness can read the presented bytes. The default
   * production configuration never exposes a readback helper.
   */
  readonly debug?: boolean;
}

export interface PresentationPassStats {
  /** milliseconds of this present's host encode (encoder -> submit) */
  readonly hostEncodeMs: number;
  /** true when this present actually called `context.configure()` */
  readonly configured: boolean;
  /** total queue submissions performed by this pass */
  readonly workSubmitted: number;
  readonly newAllocations: number;
  readonly allocationCount: number;
  readonly totalAllocationBytes: number;
}

export interface PresentationPassSnapshot {
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
  /** the browser-preferred canvas format actually used (rgba8unorm | bgra8unorm) */
  readonly canvasFormat: Canvas8BitFormat;
  readonly alphaMode: typeof PRESENTATION_ALPHA_MODE;
  readonly colorSpace: typeof PRESENTATION_COLOR_SPACE;
  /** whether the last present requested the test-only COPY_SRC usage */
  readonly debug: boolean;
  /** the effective (sanitized, CPU-compatible) composite options */
  readonly composite: EffectiveCompositeOptions;
  /** queue submissions performed so far */
  readonly workSubmitted: number;
  /** how many times `context.configure()` was actually called */
  readonly configurationGeneration: number;
  /** milliseconds of the last present's host encode (encoder -> submit) */
  readonly hostEncodeMs: number;
}

/**
 * Build the narrow #28 color binding consumed by `PresentationPass` from the
 * lighting snapshot — the exact `color` buffer, the snapshot render extent
 * and the propagated per-HeightPass-dispatch provenance token.
 */
export function presentationColorBindingFromLightingPass(
  snapshot: LightingPassSnapshot,
): PresentationInputBinding {
  const color = snapshot.color;
  return {
    buffer: color.buffer,
    byteLength: color.byteLength,
    format: color.format as "rgba8",
    channels: color.channels,
    usage: color.usage,
    width: snapshot.width,
    height: snapshot.height,
    dpr: snapshot.dpr,
    provenance: snapshot.provenance,
  };
}

/**
 * Build the narrow #25 object-id binding consumed by `PresentationPass`
 * from the height snapshot — the exact `outputs.objectId` buffer and its
 * per-HeightPass-dispatch provenance token.
 */
export function presentationObjectIdBindingFromHeightPass(
  snapshot: HeightPassSnapshot,
): PresentationInputBinding {
  const binding = snapshot.outputs.objectId;
  return {
    buffer: binding.buffer,
    byteLength: binding.byteLength,
    format: binding.format as "u32",
    channels: 1,
    usage: binding.usage,
    width: snapshot.width,
    height: snapshot.height,
    dpr: snapshot.dpr,
    provenance: snapshot.provenance,
  };
}

/**
 * Build the narrow #27 visibility binding consumed by `PresentationPass`
 * from the shadow snapshot — the exact `output` buffer, the snapshot render
 * extent and the propagated per-HeightPass-dispatch provenance token.
 */
export function presentationVisibilityBindingFromShadowPass(
  snapshot: ShadowPassSnapshot,
): PresentationInputBinding {
  const output = snapshot.output;
  return {
    buffer: output.buffer,
    byteLength: output.byteLength,
    format: output.format as "f32",
    channels: output.channels,
    usage: output.usage,
    width: snapshot.width,
    height: snapshot.height,
    dpr: snapshot.dpr,
    provenance: snapshot.provenance,
  };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

type PresentationAllocationName = "uniform";

interface CachedPresentationPipeline {
  layout: GpuBindGroupLayoutLike;
  pipelineLayout: GpuPipelineLayoutLike;
  pipeline: GpuRenderPipelineLike;
}

export class PresentationPass {
  private readonly allocations = new Map<PresentationAllocationName, GpuBufferLike>();
  private readonly allocationSizes = new Map<PresentationAllocationName, number>();
  private readonly uniformBytes = new Uint8Array(PRESENTATION_PARAMS_BYTE_LENGTH);
  private readonly pipelines = new Map<string, CachedPresentationPipeline>();
  /** ONE cached shader module; every format-cached pipeline reuses it. */
  private module: GpuShaderModuleLike | null = null;
  /** ONE explicit bind-group layout (format-independent buffer bindings). */
  private bindGroupLayout: GpuBindGroupLayoutLike | null = null;
  private newAllocations = 0;
  private lost = false;
  private disposed = false;
  private last: {
    width: number;
    height: number;
    dpr: number;
    canvasFormat: Canvas8BitFormat;
    debug: boolean;
    composite: EffectiveCompositeOptions;
  } | null = null;
  private workSubmitted = 0;
  private configurationGeneration = 0;
  private configKey: string | null = null;
  private hostEncodeMs = 0;
  /** the context this pass configured (unconfigured on dispose) */
  private lastContext: GpuCanvasContextLike | null = null;

  constructor(private readonly device: GpuPresentationDeviceLike) {
    // Fail closed on device loss: reject presentation without touching a
    // stale context or submitting more work.
    this.device.lost
      .then(() => {
        this.lost = true;
      })
      .catch(() => {
        this.lost = true;
      });
  }

  /**
   * Present the three exact GPU fields to the canvas context. Strict
   * validation, provenance, limits and allocation bounds all run BEFORE any
   * device/context call; normal execution then performs one uniform upload,
   * one render pass (clear, pipeline, bind group, draw 3, end) and one queue
   * submission — no map, no readback, no intermediate texture.
   */
  present(input: PresentationPassInput): PresentationPassStats {
    if (this.disposed) {
      throw new Error("presentation pass is disposed: construct a fresh pass to present again");
    }
    if (this.lost) {
      throw new Error("device is lost: presentation is rejected without touching a stale context");
    }
    const render = this.assertBindings(input);
    const { texelCount, renderWidth, renderHeight, dpr } = render;
    const canvasFormat = this.assertCanvasFormat(input);
    this.assertBackingStore(input.context, renderWidth, renderHeight);
    this.assertDeviceLimits(texelCount * 4);
    const debug = input.debug === true;
    const composite = sanitizeCompositeOptions(input.options);

    // One reusable/growing uniform allocation; every GPUBufferBinding below
    // carries an explicit validated size.
    this.ensureAllocation("uniform", PRESENTATION_PARAMS_BYTE_LENGTH);
    this.packUniform(renderWidth, renderHeight, composite);
    this.device.queue.writeBuffer(this.allocation("uniform"), 0, this.uniformBytes);

    const cached = this.ensurePipeline(canvasFormat);
    const texelBytes = texelCount * 4;
    const group = this.device.createBindGroup({
      label: "ukibori-presentation-pass",
      layout: cached.layout,
      entries: [
        { binding: 0, resource: { buffer: this.allocation("uniform"), size: PRESENTATION_PARAMS_BYTE_LENGTH } },
        // The #25/#27/#28 fields are consumed DIRECTLY (narrow structural
        // casts at this boundary, never copies into new input allocations).
        { binding: 1, resource: { buffer: input.color.buffer, size: texelBytes } },
        { binding: 2, resource: { buffer: input.objectId.buffer, size: texelBytes } },
        { binding: 3, resource: { buffer: input.visibility.buffer, size: texelBytes } },
      ],
    });

    // Configuration is reused while the context identity, device, format
    // and debug usage are unchanged; backing-store resizes are picked up by
    // the fresh current texture. A different context never skips configure()
    // because it happens to use the same format: switching contexts
    // explicitly unconfigures the previous one first.
    const configKey = `${canvasFormat}|${debug ? "copy-src" : "none"}`;
    let configured = false;
    if (this.lastContext !== input.context || this.configKey !== configKey) {
      if (this.lastContext !== null && this.lastContext !== input.context && !this.lost) {
        try {
          this.lastContext.unconfigure();
        } catch {
          // a stale context must never block configuration of the new one
        }
      }
      input.context.configure({
        device: this.device,
        format: canvasFormat,
        usage: GPU_USAGE_RENDER_ATTACHMENT | (debug ? GPU_TEXTURE_USAGE_COPY_SRC : 0),
        alphaMode: PRESENTATION_ALPHA_MODE,
        colorSpace: PRESENTATION_COLOR_SPACE,
      });
      this.lastContext = input.context;
      this.configKey = configKey;
      this.configurationGeneration += 1;
      configured = true;
    }

    // Per-call host encode time: render-pass encoding through the queue
    // submission (GPU execution and test readback are never included).
    const encodeStart = performance.now();
    const encoder = this.device.createCommandEncoder({ label: "ukibori-presentation-pass" });
    const pass = encoder.beginRenderPass({
      label: "ukibori-presentation-pass",
      colorAttachments: [
        {
          view: input.context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    pass.setPipeline(cached.pipeline);
    pass.setBindGroup(0, group);
    pass.draw(3);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
    this.hostEncodeMs = performance.now() - encodeStart;

    this.workSubmitted += 1;
    this.last = {
      width: renderWidth,
      height: renderHeight,
      dpr,
      canvasFormat,
      debug,
      composite,
    };

    const stats: PresentationPassStats = {
      hostEncodeMs: this.hostEncodeMs,
      configured,
      workSubmitted: this.workSubmitted,
      newAllocations: this.newAllocations,
      allocationCount: this.allocations.size,
      totalAllocationBytes: sumOf(this.allocationSizes),
    };
    this.newAllocations = 0;
    return stats;
  }

  /**
   * Stable read-only snapshot; throws before the first successful present,
   * after disposal or after device loss (fail-closed — no stale snapshot).
   */
  getSnapshot(): PresentationPassSnapshot {
    if (this.disposed) {
      throw new Error("presentation pass is disposed");
    }
    if (this.lost) {
      throw new Error("device is lost: no usable presentation snapshot");
    }
    if (this.last === null) {
      throw new Error("no present: present() has not completed or dispose() was called");
    }
    return {
      width: this.last.width,
      height: this.last.height,
      dpr: this.last.dpr,
      canvasFormat: this.last.canvasFormat,
      alphaMode: PRESENTATION_ALPHA_MODE,
      colorSpace: PRESENTATION_COLOR_SPACE,
      debug: this.last.debug,
      composite: this.last.composite,
      workSubmitted: this.workSubmitted,
      configurationGeneration: this.configurationGeneration,
      hostEncodeMs: this.hostEncodeMs,
    };
  }

  /**
   * Unconfigure the context (unless the device is lost), destroy every
   * owned allocation (never foreign field buffers) and reset the snapshot.
   * Idempotent.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (!this.lost) {
      // unconfigure needs no device; skip it on loss so a stale context is
      // never touched (#29 fail-closed contract).
      try {
        this.lastContext?.unconfigure();
      } catch {
        // disposal must never mask the primary outcome
      }
    }
    this.lastContext = null;
    for (const buffer of this.allocations.values()) {
      buffer.destroy();
    }
    this.allocations.clear();
    this.allocationSizes.clear();
    this.newAllocations = 0;
    this.last = null;
  }

  // -- validation (all BEFORE any device/context call) ---------------------

  private assertBindings(input: PresentationPassInput): {
    texelCount: number;
    renderWidth: number;
    renderHeight: number;
    dpr: number;
  } {
    for (const [name, binding] of [
      ["color", input.color],
      ["objectId", input.objectId],
      ["visibility", input.visibility],
    ] as const) {
      if (!Number.isInteger(binding.width) || binding.width <= 0) {
        throw new Error(
          `${name} binding width must be a positive integer, got ${binding.width}`,
        );
      }
      if (!Number.isInteger(binding.height) || binding.height <= 0) {
        throw new Error(
          `${name} binding height must be a positive integer, got ${binding.height}`,
        );
      }
    }
    const { width: renderWidth, height: renderHeight, dpr } = input.color;
    if (
      input.objectId.width !== renderWidth ||
      input.objectId.height !== renderHeight ||
      input.visibility.width !== renderWidth ||
      input.visibility.height !== renderHeight
    ) {
      throw new Error(
        `mixed presentation extents: color ${input.color.width}x${input.color.height}, ` +
          `objectId ${input.objectId.width}x${input.objectId.height}, ` +
          `visibility ${input.visibility.width}x${input.visibility.height} — all three must ` +
          `be ${renderWidth}x${renderHeight}`,
      );
    }
    if (input.objectId.dpr !== dpr || input.visibility.dpr !== dpr) {
      throw new Error(
        `mixed presentation DPR: color ${dpr}, objectId ${input.objectId.dpr}, ` +
          `visibility ${input.visibility.dpr} — all three must match`,
      );
    }
    const texelCount = renderWidth * renderHeight;
    if (!Number.isSafeInteger(texelCount) || texelCount > U32_MAX) {
      throw new Error(
        `render texel count ${renderWidth}x${renderHeight} exceeds u32 (${U32_MAX}) or safe integers`,
      );
    }
    const expectedBytes = texelCount * 4;
    const provenance = input.color.provenance;
    if (
      input.objectId.provenance !== provenance ||
      input.visibility.provenance !== provenance
    ) {
      throw new Error(
        "mixed HeightPass provenance: color, objectId and visibility must come " +
          "from one successful HeightPass dispatch",
      );
    }
    if (
      provenance.width !== renderWidth ||
      provenance.height !== renderHeight ||
      provenance.dpr !== dpr
    ) {
      throw new Error(
        `HeightPass provenance extent ${provenance.width}x${provenance.height} at dpr ` +
          `${provenance.dpr} != presentation extent ${renderWidth}x${renderHeight} at dpr ${dpr}`,
      );
    }
    // Authenticity: the provenance carries the EXACT encoded scene bytes the
    // HeightPass dispatch consumed. Its header (renderWidth at offset 24,
    // renderHeight at 28, dpr f32 at 32 — the #24 ABI) must agree with the
    // provenance's own extent claims, so a hand-crafted/foreign provenance
    // is detectable on the host without any presentation-device/context call.
    const provenanceBytes = provenance.sceneBytes;
    if (
      provenanceBytes === undefined ||
      provenanceBytes.byteLength < HEADER_SIZE
    ) {
      throw new Error(
        "foreign HeightPass provenance: sceneBytes is missing or shorter than the ABI header",
      );
    }
    const headerView = new DataView(
      provenanceBytes.buffer,
      provenanceBytes.byteOffset,
      provenanceBytes.byteLength,
    );
    const headerWidth = headerView.getUint32(24, true);
    const headerHeight = headerView.getUint32(28, true);
    const headerDpr = headerView.getFloat32(32, true);
    if (
      headerWidth !== provenance.width ||
      headerHeight !== provenance.height ||
      headerDpr !== provenance.dpr
    ) {
      throw new Error(
        `foreign HeightPass provenance: scene header ${headerWidth}x${headerHeight} at dpr ` +
          `${headerDpr} != provenance claims ${provenance.width}x${provenance.height} at dpr ` +
          `${provenance.dpr}`,
      );
    }
    for (const [name, binding] of [
      ["color", input.color],
      ["objectId", input.objectId],
      ["visibility", input.visibility],
    ] as const) {
      const expectedFormat = name === "color" ? "rgba8" : name === "objectId" ? "u32" : "f32";
      if (binding.format !== expectedFormat) {
        throw new Error(
          `${name} binding format ${String(binding.format)} != ${expectedFormat}`,
        );
      }
      const expectedChannels = name === "color" ? 4 : 1;
      if (binding.channels !== expectedChannels) {
        throw new Error(
          `${name} binding channels ${binding.channels} != ${expectedChannels}`,
        );
      }
      if (binding.byteLength !== expectedBytes) {
        throw new Error(
          `${name} binding byteLength ${binding.byteLength} != expected ${expectedBytes} ` +
            `(${renderWidth}x${renderHeight} field)`,
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
            `(${renderWidth}x${renderHeight} field)`,
        );
      }
    }
    return { texelCount, renderWidth, renderHeight, dpr };
  }

  private assertCanvasFormat(input: PresentationPassInput): Canvas8BitFormat {
    const format = input.canvasFormat;
    if (format !== "rgba8unorm" && format !== "bgra8unorm") {
      throw new Error(
        `canvas format ${format} is not an 8-bit RGBA/BGRA format ` +
          `(rgba8unorm or bgra8unorm): resolve the browser-preferred format once ` +
          `via navigator.gpu.getPreferredCanvasFormat() at the real API boundary ` +
          `and supply it in the present input`,
      );
    }
    return format;
  }

  private assertBackingStore(
    context: GpuCanvasContextLike,
    renderWidth: number,
    renderHeight: number,
  ): void {
    const { width, height } = context.canvas;
    if (width !== renderWidth || height !== renderHeight) {
      throw new Error(
        `canvas backing store ${width}x${height} != render extent ` +
          `${renderWidth}x${renderHeight}: resize the canvas backing store to the ` +
          `encoded render extent before presenting`,
      );
    }
  }

  private assertDeviceLimits(texelBytes: number): void {
    const limits = this.device.limits;
    const maxStorage = positiveLimit(
      limits.maxStorageBufferBindingSize,
      DEFAULT_MAX_STORAGE_BYTES,
    );
    for (const [label, byteLength] of [
      ["color field", texelBytes],
      ["objectId field", texelBytes],
      ["visibility field", texelBytes],
    ] as const) {
      if (!Number.isSafeInteger(byteLength) || byteLength <= 0 || byteLength > maxStorage) {
        throw new Error(
          `${label} binding range of ${byteLength} bytes exceeds ` +
            `maxStorageBufferBindingSize ${maxStorage}`,
        );
      }
    }
    const maxUniform = positiveLimit(
      limits.maxUniformBufferBindingSize,
      DEFAULT_MAX_UNIFORM_BYTES,
    );
    const maxBuffer = positiveLimit(limits.maxBufferSize, DEFAULT_MAX_STORAGE_BYTES);
    const uniformBound = Math.min(maxUniform, maxBuffer);
    if (
      !Number.isSafeInteger(PRESENTATION_PARAMS_BYTE_LENGTH) ||
      PRESENTATION_PARAMS_BYTE_LENGTH > uniformBound
    ) {
      throw new Error(
        `presentation params uniform allocation of ${PRESENTATION_PARAMS_BYTE_LENGTH} bytes ` +
          `exceeds device limits (maxUniformBufferBindingSize ${maxUniform}, ` +
          `maxBufferSize ${maxBuffer})`,
      );
    }
  }

  // -- allocations ----------------------------------------------------------

  private ensureAllocation(name: PresentationAllocationName, byteLength: number): GpuBufferLike {
    const required = Math.max(byteLength, MIN_PASS_ALLOCATION_BYTES);
    const current = this.allocations.get(name);
    if (current !== undefined && current.size >= required) {
      return current;
    }
    if (current !== undefined) {
      current.destroy();
    }
    const created = this.device.createBuffer({
      size: required,
      usage: 0x40 | GPU_USAGE_COPY_DST, // UNIFORM | COPY_DST (spec bit values)
      label: `ukibori-${name}`,
    });
    this.allocations.set(name, created);
    this.allocationSizes.set(name, created.size);
    this.newAllocations += 1;
    return created;
  }

  private allocation(name: PresentationAllocationName): GpuBufferLike {
    const buffer = this.allocations.get(name);
    if (buffer === undefined) {
      throw new Error(`missing allocation for ${name}`);
    }
    return buffer;
  }

  // -- host packing (little-endian, offsets pinned by presentation-pass-wgsl.ts) --

  private packUniform(
    width: number,
    height: number,
    composite: EffectiveCompositeOptions,
  ): void {
    const view = new DataView(this.uniformBytes.buffer);
    view.setUint32(0, width, true);
    view.setUint32(4, height, true);
    // Sanitized bytes may be NaN (the CPU compositor's clampByte output);
    // the byte | 0 coercion mirrors the Uint8ClampedArray store semantics
    // the DOM overlay gets for a NaN channel (byte 0).
    view.setUint32(8, composite.shadowColor[0] | 0, true);
    view.setUint32(12, composite.shadowColor[1] | 0, true);
    view.setUint32(16, composite.shadowColor[2] | 0, true);
    view.setUint32(20, compositeShadowAlphaByte(composite.shadowAlpha), true);
    view.setUint32(24, 0, true);
    view.setUint32(28, 0, true);
  }

  // -- pipeline and bind group ----------------------------------------------

  private ensurePipeline(format: Canvas8BitFormat): CachedPresentationPipeline {
    const cached = this.pipelines.get(format);
    if (cached !== undefined) {
      return cached;
    }
    // ONE cached WGSL shader module and ONE explicit bind-group layout
    // (format-independent buffer bindings); only the pipeline layout and
    // render pipeline are cached per canvas target format. Everything is
    // explicit — never layout: "auto". The fragment stage binds 3
    // read-only storage buffers (below the spec-minimum 8) plus the
    // uniform; the vertex stage has no bindings.
    let layout = this.bindGroupLayout;
    if (layout === null) {
      layout = this.device.createBindGroupLayout({
        label: "ukibori-presentation-pass",
        entries: [
          {
            binding: 0,
            visibility: FRAGMENT_STAGE_VISIBILITY,
            buffer: {
              type: "uniform",
              hasDynamicOffset: false,
              minBindingSize: PRESENTATION_PARAMS_BYTE_LENGTH,
            },
          },
          {
            binding: 1,
            visibility: FRAGMENT_STAGE_VISIBILITY,
            buffer: {
              type: "read-only-storage",
              hasDynamicOffset: false,
              minBindingSize: 4, // at least one packed RGBA8 texel
            },
          },
          {
            binding: 2,
            visibility: FRAGMENT_STAGE_VISIBILITY,
            buffer: {
              type: "read-only-storage",
              hasDynamicOffset: false,
              minBindingSize: 4, // at least one u32 object-id texel
            },
          },
          {
            binding: 3,
            visibility: FRAGMENT_STAGE_VISIBILITY,
            buffer: {
              type: "read-only-storage",
              hasDynamicOffset: false,
              minBindingSize: 4, // at least one f32 visibility texel
            },
          },
        ],
      });
      this.bindGroupLayout = layout;
    }
    let module = this.module;
    if (module === null) {
      module = this.device.createShaderModule({
        code: PRESENTATION_PASS_WGSL,
        label: "ukibori-presentation-pass",
      });
      this.module = module;
    }
    const pipelineLayout = this.device.createPipelineLayout({
      label: "ukibori-presentation-pass",
      bindGroupLayouts: [layout],
    });
    const pipeline = this.device.createRenderPipeline({
      label: "ukibori-presentation-pass",
      layout: pipelineLayout,
      vertex: { module, entryPoint: "vs_main" },
      fragment: {
        module,
        entryPoint: "fs_main",
        targets: [{ format, label: "ukibori-presentation-pass" }],
      },
      primitive: { topology: "triangle-list" },
    });
    const created = { layout, pipelineLayout, pipeline };
    this.pipelines.set(format, created);
    return created;
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

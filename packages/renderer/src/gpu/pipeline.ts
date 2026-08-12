import type { NormalOptions } from "../lighting";
import type { Scene } from "../scene";
import type { ShadowOptions } from "../shadow";
import { encodeScene } from "./encode";
import { HeightPass } from "./height-pass";
import type { GpuComputeDeviceLike, HeightPassDispatchStats, HeightPassSnapshot } from "./height-pass";
import { LightingPass } from "./lighting-pass";
import type {
  LightingPassDispatchStats,
  LightingPassOptions,
  LightingPassSnapshot,
} from "./lighting-pass";
import { NormalPass } from "./normal-pass";
import type { NormalPassDispatchStats, NormalPassSnapshot } from "./normal-pass";
import {
  PresentationPass,
  presentationColorBindingFromLightingPass,
  presentationObjectIdBindingFromHeightPass,
  presentationVisibilityBindingFromShadowPass,
} from "./presentation-pass";
import type { Canvas8BitFormat, GpuCanvasContextLike, GpuPresentationDeviceLike, PresentationPassSnapshot, PresentationPassStats } from "./presentation-pass";
import { ShadowPass } from "./shadow-pass";
import type { ShadowPassDispatchStats, ShadowPassSnapshot } from "./shadow-pass";
import { SceneUploader } from "./uploader";
import type { UploadStats } from "./uploader";
import type { CompositeOptions } from "./composite";
import {
  lightingMaterialIdBindingFromHeightPass,
  lightingNormalBindingFromNormalPass,
  lightingVisibilityBindingFromShadowPass,
} from "./lighting-pass";
import { normalHeightBindingFromHeightPass } from "./normal-pass";
import { shadowHeightBindingsFromHeightPass } from "./shadow-pass";

/**
 * #29 full-chain `GpuScenePipeline` — a small internal production
 * orchestrator which owns and calls, in order:
 *
 * ```text
 * encodeScene -> SceneUploader -> HeightPass -> NormalPass -> ShadowPass
 *             -> LightingPass -> PresentationPass
 * ```
 *
 * ## Contract
 *
 * - The render input is the existing `Scene`, DPR, normal/shadow/lighting
 *   and composite options. No public scene/material redesign.
 * - The canvas backing store is resized to the encoded render extent before
 *   presentation. CSS positioning/size remains a DOM-layer responsibility.
 * - Every downstream binding is derived through the existing public helpers
 *   so the per-dispatch provenance is current on every frame.
 * - Every compute pass runs on every requested frame. Pass-level
 *   allocations and pipelines reuse their existing caches; skipping
 *   unaffected passes and retaining a dependency graph belong to #31.
 * - `render()` returns structured per-pass dispatch statistics plus the
 *   presentation statistics. No host copies of intermediate/final pixel
 *   data are ever exposed.
 * - `present()` re-presents the last rendered frame WITHOUT re-running the
 *   compute passes — the #29 presentation-only benchmark/test seam (timed
 *   from render-pass encoding through `queue.onSubmittedWorkDone()`,
 *   excluding compute and scene upload). It is not a dirty-pass scheduler;
 *   #31 owns pass skipping.
 * - The canvas backing store the pipeline resizes is the SAME object the
 *   presentation context exposes (`context.canvas`); there is no redundant
 *   independent canvas parameter that could diverge from the context.
 * - `dispose()` disposes in reverse ownership order (presentation ->
 *   lighting -> shadow -> normal -> height -> uploader), never destroys
 *   foreign canvas/device resources twice, and leaves no usable stale
 *   snapshot after disposal or device loss.
 *
 * ## Structural device interface
 *
 * `GpuPipelineDeviceLike` is the intersection of the compute-pass mirror
 * (`GpuComputeDeviceLike`) and the presentation mirror
 * (`GpuPresentationDeviceLike`): the real `GPUDevice` satisfies both (the
 * cast happens at the harness boundary; the Node test mock implements the
 * same surface). The canvas target format is resolved ONCE by the caller
 * from `navigator.gpu.getPreferredCanvasFormat()` at the real API boundary
 * and validated by the presentation pass; the pipeline never calls
 * `navigator.gpu` or a fabricated context method itself.
 */

export type GpuPipelineDeviceLike = GpuComputeDeviceLike & GpuPresentationDeviceLike;

export interface GpuScenePipelineInput {
  /** the EXISTING #13 scene model (no redesign) */
  readonly scene: Scene;
  /** render device pixel ratio (finite > 0; floor-extent rule like the encoder) */
  readonly dpr: number;
  /** CPU-compatible normal options; sanitized like the oracle */
  readonly normalOptions?: NormalOptions;
  /** CPU-compatible shadow options; sanitized like the oracle */
  readonly shadowOptions?: ShadowOptions;
  /** CPU-compatible lighting options (ambient); sanitized like the oracle */
  readonly lightingOptions?: LightingPassOptions;
  /** CPU-compatible composite options; sanitized like the CPU compositor */
  readonly compositeOptions?: CompositeOptions;
  /** test-only: request COPY_SRC on the canvas texture usage (never production) */
  readonly debugReadback?: boolean;
}

export interface GpuScenePipelineFrameStats {
  readonly renderWidth: number;
  readonly renderHeight: number;
  readonly dpr: number;
  readonly upload: UploadStats;
  readonly height: HeightPassDispatchStats;
  readonly normal: NormalPassDispatchStats;
  readonly shadow: ShadowPassDispatchStats;
  readonly lighting: LightingPassDispatchStats;
  readonly presentation: PresentationPassStats;
}

export interface GpuScenePipelineSnapshot {
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
  readonly heightPass: HeightPassSnapshot;
  readonly normalPass: NormalPassSnapshot;
  readonly shadowPass: ShadowPassSnapshot;
  readonly lightingPass: LightingPassSnapshot;
  readonly presentationPass: PresentationPassSnapshot;
}

export class GpuScenePipeline {
  private readonly device: GpuPipelineDeviceLike;
  private readonly context: GpuCanvasContextLike;
  private readonly canvasFormat: Canvas8BitFormat;
  private readonly uploader: SceneUploader;
  private readonly heightPass: HeightPass;
  private readonly normalPass: NormalPass;
  private readonly shadowPass: ShadowPass;
  private readonly lightingPass: LightingPass;
  private readonly presentationPass: PresentationPass;
  private lost = false;
  private disposed = false;
  private lastFrame: {
    readonly width: number;
    readonly height: number;
    readonly dpr: number;
    readonly heightPass: HeightPassSnapshot;
    readonly normalPass: NormalPassSnapshot;
    readonly shadowPass: ShadowPassSnapshot;
    readonly lightingPass: LightingPassSnapshot;
    readonly compositeOptions: CompositeOptions | undefined;
    readonly debugReadback: boolean;
  } | null = null;

  constructor(
    device: GpuPipelineDeviceLike,
    context: GpuCanvasContextLike,
    canvasFormat: Canvas8BitFormat,
  ) {
    // Assigned in declaration order BEFORE the pass fields below, so every
    // pass constructor sees the owning device/context/format initialized.
    this.device = device;
    this.context = context;
    this.canvasFormat = canvasFormat;
    this.uploader = new SceneUploader(this.device);
    this.heightPass = new HeightPass(this.device);
    this.normalPass = new NormalPass(this.device);
    this.shadowPass = new ShadowPass(this.device);
    this.lightingPass = new LightingPass(this.device);
    this.presentationPass = new PresentationPass(this.device);
    this.device.lost
      .then(() => {
        this.lost = true;
      })
      .catch(() => {
        this.lost = true;
      });
  }

  /**
   * Render one full frame: encode, upload, all four compute passes and the
   * presentation. Returns the structured per-pass dispatch statistics; no
   * host copies of pixel data are exposed.
   */
  render(input: GpuScenePipelineInput): GpuScenePipelineFrameStats {
    this.assertUsable();
    const encoded = encodeScene(input.scene, input.dpr);
    const upload = this.uploader.upload(encoded);
    const bindings = this.uploader.getBindings();
    const height = this.heightPass.dispatch(encoded, bindings);
    const heightSnapshot = this.heightPass.getSnapshot();
    const normal = this.normalPass.dispatch({
      height: normalHeightBindingFromHeightPass(heightSnapshot),
      options: input.normalOptions,
    });
    const normalSnapshot = this.normalPass.getSnapshot();
    const shadow = this.shadowPass.dispatch({
      scene: encoded,
      bindings,
      ...shadowHeightBindingsFromHeightPass(heightSnapshot),
      options: input.shadowOptions,
    });
    const shadowSnapshot = this.shadowPass.getSnapshot();
    const lighting = this.lightingPass.dispatch({
      scene: encoded,
      bindings,
      materialId: lightingMaterialIdBindingFromHeightPass(heightSnapshot),
      normal: lightingNormalBindingFromNormalPass(normalSnapshot),
      visibility: lightingVisibilityBindingFromShadowPass(shadowSnapshot),
      options: input.lightingOptions,
    });
    const lightingSnapshot = this.lightingPass.getSnapshot();
    // Resize the canvas backing store (the SAME object the presentation
    // context exposes) to the encoded render extent before presentation
    // (CSS positioning/size stays a DOM-layer responsibility).
    if (this.context.canvas.width !== heightSnapshot.width) {
      this.context.canvas.width = heightSnapshot.width;
    }
    if (this.context.canvas.height !== heightSnapshot.height) {
      this.context.canvas.height = heightSnapshot.height;
    }
    const presentation = this.presentationPass.present({
      color: presentationColorBindingFromLightingPass(lightingSnapshot),
      objectId: presentationObjectIdBindingFromHeightPass(heightSnapshot),
      visibility: presentationVisibilityBindingFromShadowPass(shadowSnapshot),
      context: this.context,
      canvasFormat: this.canvasFormat,
      options: input.compositeOptions,
      debug: input.debugReadback === true,
    });
    this.lastFrame = {
      width: heightSnapshot.width,
      height: heightSnapshot.height,
      dpr: heightSnapshot.dpr,
      heightPass: heightSnapshot,
      normalPass: normalSnapshot,
      shadowPass: shadowSnapshot,
      lightingPass: lightingSnapshot,
      compositeOptions: input.compositeOptions,
      debugReadback: input.debugReadback === true,
    };
    return {
      renderWidth: heightSnapshot.width,
      renderHeight: heightSnapshot.height,
      dpr: heightSnapshot.dpr,
      upload,
      height,
      normal,
      shadow,
      lighting,
      presentation,
    };
  }

  /**
   * Re-present the LAST rendered frame without re-running the compute
   * passes (the #29 presentation-only benchmark seam; #31 owns pass
   * skipping and scheduling). Throws before the first `render()`.
   */
  present(): PresentationPassStats {
    this.assertUsable();
    const frame = this.lastFrame;
    if (frame === null) {
      throw new Error("no frame rendered: call render() before presenting");
    }
    if (this.context.canvas.width !== frame.width) {
      this.context.canvas.width = frame.width;
    }
    if (this.context.canvas.height !== frame.height) {
      this.context.canvas.height = frame.height;
    }
    return this.presentationPass.present({
      color: presentationColorBindingFromLightingPass(frame.lightingPass),
      objectId: presentationObjectIdBindingFromHeightPass(frame.heightPass),
      visibility: presentationVisibilityBindingFromShadowPass(frame.shadowPass),
      context: this.context,
      canvasFormat: this.canvasFormat,
      options: frame.compositeOptions,
      debug: frame.debugReadback,
    });
  }

  /**
   * Stable structured snapshot of the last successful frame's pass
   * snapshots. Throws before the first `render()`, after `dispose()` and
   * after device loss (no usable stale snapshot).
   */
  getSnapshot(): GpuScenePipelineSnapshot {
    if (this.disposed) {
      throw new Error("GpuScenePipeline is disposed");
    }
    if (this.lost) {
      throw new Error("device is lost: no usable pipeline snapshot");
    }
    const frame = this.lastFrame;
    if (frame === null) {
      throw new Error("no frame rendered: render() has not completed");
    }
    return {
      width: frame.width,
      height: frame.height,
      dpr: frame.dpr,
      heightPass: frame.heightPass,
      normalPass: frame.normalPass,
      shadowPass: frame.shadowPass,
      lightingPass: frame.lightingPass,
      presentationPass: this.presentationPass.getSnapshot(),
    };
  }

  /**
   * Dispose in reverse ownership order — presentation, lighting, shadow,
   * normal, height, uploader — never touching the foreign canvas/device
   * resources twice. Idempotent; leaves no usable stale snapshot.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.presentationPass.dispose();
    this.lightingPass.dispose();
    this.shadowPass.dispose();
    this.normalPass.dispose();
    this.heightPass.dispose();
    this.uploader.dispose();
    this.lastFrame = null;
  }

  private assertUsable(): void {
    if (this.disposed) {
      throw new Error("GpuScenePipeline is disposed: construct a fresh pipeline to render again");
    }
    if (this.lost) {
      throw new Error("device is lost: the pipeline rejects without submitting more work");
    }
  }
}

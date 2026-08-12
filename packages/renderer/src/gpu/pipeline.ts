import type { NormalOptions } from "../lighting";
import type { Scene } from "../scene";
import type { ShadowOptions } from "../shadow";
import { encodeScene } from "./encode";
import type { EncodedScene } from "./encode";
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
import { computeFrameKey, reportInvalidations } from "./dirty";
import type { FrameKey, InvalidationReport } from "./dirty";
import { GpuPipelineProfiler } from "./profiler";
import type { CumulativeProfile, FrameProfile, ProfilerStageRecord } from "./profiler";

/**
 * #31 `GpuScenePipeline` — the #29 full-chain orchestrator rebuilt around
 * the small explicit invalidation dependency graph (`gpu/dirty.ts`):
 *
 * ```text
 * encodeScene -> SceneUploader -> HeightPass -> NormalPass -> ShadowPass
 *             -> LightingPass -> PresentationPass
 * ```
 *
 * ## Retained resources
 *
 * Pipelines, bind groups, buffers, textures and samplers are RETAINED
 * across unchanged frames. `render()` compares stable canonical
 * fingerprints of the effective frame inputs (encoded scene bytes + DPR +
 * sanitized options; see `computeFrameKey`) against the previous frame and
 * executes ONLY the dirty stages and their downstream dependencies:
 *
 * - byte-identical frame -> NO upload, NO compute dispatch, NO
 *   presentation; the canvas keeps the previously presented frame. The
 *   caller can request a retained re-presentation with `repaint: true`
 *   (presentation stage only, from retained outputs).
 * - viewport/scene change -> the full chain (upload through presentation),
 *   because the #25 provenance token (carrying the exact encoded bytes)
 *   changes and every downstream pass rejects foreign/mixed provenance.
 * - normal/shadow/lighting option changes -> only the affected pass(es)
 *   and their downstream dependencies re-run (provenance is unchanged).
 * - composite/debug target changes -> presentation only.
 *
 * Each `render()` reports the invalidation reasons, the executed/skipped
 * stage sets, per-stage statistics, a per-frame profile and the cumulative
 * profiler totals. All durations are WALL-CLOCK HOST times (labeled
 * `hostMs`); no GPU timestamps are fabricated.
 *
 * ## Contract (unchanged from #29)
 *
 * - The render input is the existing `Scene`, DPR, normal/shadow/lighting
 *   and composite options. No public scene/material redesign.
 * - The canvas backing store is resized to the encoded render extent before
 *   presentation. CSS positioning/size remains a DOM-layer responsibility.
 * - Every downstream binding is derived through the existing public helpers
 *   so per-dispatch provenance is current on every executed frame.
 * - `render()` returns structured per-pass dispatch statistics plus the
 *   scheduler report and profiling; no host copies of intermediate/final
 *   pixel data are ever exposed.
 * - `present()` re-presents the last rendered frame WITHOUT re-running the
 *   compute passes (the #29 presentation-only benchmark seam).
 * - `dispose()` disposes in reverse ownership order (presentation ->
 *   lighting -> shadow -> normal -> height -> uploader), never destroys
 *   foreign canvas/device resources twice, and leaves no usable stale
 *   snapshot after disposal or device loss. Resource recovery is explicit:
 *   construct a fresh pipeline with a fresh device/context (the context
 *   recovery seam); nothing is retained beyond the owning pipeline.
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
  /**
   * #31: when the frame is byte-identical (fully retained), explicitly
   * re-present the retained frame from retained outputs WITHOUT re-running
   * any upload or compute dispatch. Presentation runs normally when a
   * dirty reason already includes it; this flag only adds it otherwise.
   */
  readonly repaint?: boolean;
}

export interface GpuScenePipelineFrameStats {
  readonly renderWidth: number;
  readonly renderHeight: number;
  readonly dpr: number;
  /** the #31 scheduler report: reasons + executed/skipped stages */
  readonly invalidation: InvalidationReport;
  readonly upload: UploadStats;
  readonly height: HeightPassDispatchStats;
  readonly normal: NormalPassDispatchStats;
  readonly shadow: ShadowPassDispatchStats;
  readonly lighting: LightingPassDispatchStats;
  readonly presentation: PresentationPassStats;
  /** per-frame profiling (allocations, uploaded bytes, dispatches, timings) */
  readonly frame: FrameProfile;
  /** cumulative profiling across every successful render()/present() */
  readonly totals: CumulativeProfile;
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

const ZERO_UPLOAD: UploadStats = {
  writeCalls: 0,
  bytesUploaded: 0,
  allocationCount: 0,
  newAllocations: 0,
};

const ZERO_HEIGHT: HeightPassDispatchStats = {
  newAllocations: 0,
  allocationCount: 0,
  totalAllocationBytes: 0,
  maskSdfPasses: 0,
  composePasses: 0,
};

const ZERO_FIELD_DISPATCH = {
  newAllocations: 0,
  allocationCount: 0,
  totalAllocationBytes: 0,
  workgroupCountX: 0,
};

const ZERO_PRESENTATION: PresentationPassStats = {
  hostEncodeMs: 0,
  configured: false,
  workSubmitted: 0,
  newAllocations: 0,
  allocationCount: 0,
  totalAllocationBytes: 0,
};

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
  private readonly profiler = new GpuPipelineProfiler();
  private lost = false;
  private disposed = false;
  private lastKey: FrameKey | null = null;
  /**
   * The exact `EncodedScene` object whose bytes were last uploaded and
   * dispatched. Reused on content-identical frames: `encodeScene()` always
   * allocates a fresh `bytes` object, but the #24/#28 provenance checks are
   * OBJECT-identity based, so a byte-identical re-encoding must keep the
   * retained bytes object (stable canonical fingerprint comparison proves
   * the content is identical).
   */
  private lastEncoded: EncodedScene | null = null;
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
  /** last known stats per stage (reported with zeroed activity when skipped) */
  private readonly retained = {
    upload: ZERO_UPLOAD,
    height: ZERO_HEIGHT,
    normal: { ...ZERO_FIELD_DISPATCH },
    shadow: { ...ZERO_FIELD_DISPATCH },
    lighting: { ...ZERO_FIELD_DISPATCH },
    presentation: ZERO_PRESENTATION,
  };

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
   * Render one frame through the #31 dirty-pass scheduler: encode, compare
   * stable fingerprints against the previous frame, then execute ONLY the
   * invalidated stages (and their downstream dependencies). Returns the
   * scheduler report, per-pass statistics and the frame/cumulative
   * profiling. No host copies of pixel data are exposed.
   *
   * The frame is TRANSACTIONAL: if any stage throws after the uploader or
   * a pass has mutated its retained state, the scheduler retention
   * (`lastKey`/`lastEncoded`/`lastFrame`) is invalidated conservatively
   * before the error propagates, so the next render always recomputes from
   * a fresh full chain instead of skipping upload or reusing mixed
   * provenance from the partially-executed frame.
   */
  render(input: GpuScenePipelineInput): GpuScenePipelineFrameStats {
    try {
      return this.renderFrame(input);
    } catch (error) {
      // Conservative invalidation on ANY failure: a partially-mutated
      // uploader/pass state must never be trusted by the next frame.
      this.lastKey = null;
      this.lastEncoded = null;
      this.lastFrame = null;
      throw error;
    }
  }

  private renderFrame(input: GpuScenePipelineInput): GpuScenePipelineFrameStats {
    this.assertUsable();
    const encoded = encodeScene(input.scene, input.dpr);
    const key = computeFrameKey(encoded, input);
    const report = reportInvalidations(key, this.lastKey, input.repaint === true);
    const executed = new Set(report.executed);
    const records: ProfilerStageRecord[] = [];
    // A content-identical encoding reuses the retained bytes object so the
    // uploader bindings and the HeightPass provenance (both object-identity
    // based, #24/#28) stay valid without re-uploading. This is exactly the
    // case where the scheduler skips the upload stage; every dirty upload
    // (first frame / viewport / scene) uses the fresh encoding below.
    const scene =
      this.lastEncoded !== null &&
      this.lastKey !== null &&
      key.scene === this.lastKey.scene &&
      key.viewport === this.lastKey.viewport
        ? this.lastEncoded
        : encoded;

    let upload: UploadStats;
    if (executed.has("upload")) {
      const t0 = performance.now();
      upload = this.uploader.upload(scene);
      const hostMs = performance.now() - t0;
      records.push({
        stage: "upload",
        hostMs,
        newAllocations: upload.newAllocations,
        bytesUploaded: upload.bytesUploaded,
        dispatches: 0,
        // SceneUploader performs ONLY queue.writeBuffer calls and never a
        // queue.submit, so the upload stage reports zero submissions.
        submissions: 0,
      });
      this.retained.upload = upload;
    } else {
      upload = skippedUpload(this.retained.upload);
    }
    const bindings = this.uploader.getBindings();

    let height: HeightPassDispatchStats;
    if (executed.has("height")) {
      const t0 = performance.now();
      height = this.heightPass.dispatch(scene, bindings);
      const hostMs = performance.now() - t0;
      records.push({
        stage: "height",
        hostMs,
        newAllocations: height.newAllocations,
        bytesUploaded: 0,
        dispatches: height.maskSdfPasses + height.composePasses,
        submissions: 1,
      });
      this.retained.height = height;
    } else {
      height = skippedHeight(this.retained.height);
    }
    const heightSnapshot = this.heightPass.getSnapshot();

    let normal: NormalPassDispatchStats;
    if (executed.has("normal")) {
      const t0 = performance.now();
      normal = this.normalPass.dispatch({
        height: normalHeightBindingFromHeightPass(heightSnapshot),
        options: input.normalOptions,
      });
      const hostMs = performance.now() - t0;
      records.push({
        stage: "normal",
        hostMs,
        newAllocations: normal.newAllocations,
        bytesUploaded: 0,
        dispatches: 1,
        submissions: 1,
      });
      this.retained.normal = normal;
    } else {
      normal = skippedFieldDispatch(this.retained.normal);
    }
    const normalSnapshot = this.normalPass.getSnapshot();

    let shadow: ShadowPassDispatchStats;
    if (executed.has("shadow")) {
      const t0 = performance.now();
      shadow = this.shadowPass.dispatch({
        scene,
        bindings,
        ...shadowHeightBindingsFromHeightPass(heightSnapshot),
        options: input.shadowOptions,
      });
      const hostMs = performance.now() - t0;
      records.push({
        stage: "shadow",
        hostMs,
        newAllocations: shadow.newAllocations,
        bytesUploaded: 0,
        dispatches: 1,
        submissions: 1,
      });
      this.retained.shadow = shadow;
    } else {
      shadow = skippedFieldDispatch(this.retained.shadow);
    }
    const shadowSnapshot = this.shadowPass.getSnapshot();

    let lighting: LightingPassDispatchStats;
    if (executed.has("lighting")) {
      const t0 = performance.now();
      lighting = this.lightingPass.dispatch({
        scene,
        bindings,
        materialId: lightingMaterialIdBindingFromHeightPass(heightSnapshot),
        normal: lightingNormalBindingFromNormalPass(normalSnapshot),
        visibility: lightingVisibilityBindingFromShadowPass(shadowSnapshot),
        options: input.lightingOptions,
      });
      const hostMs = performance.now() - t0;
      records.push({
        stage: "lighting",
        hostMs,
        newAllocations: lighting.newAllocations,
        bytesUploaded: 0,
        dispatches: 1,
        submissions: 1,
      });
      this.retained.lighting = lighting;
    } else {
      lighting = skippedFieldDispatch(this.retained.lighting);
    }
    const lightingSnapshot = this.lightingPass.getSnapshot();

    const presented = executed.has("presentation") || input.repaint === true;
    let presentation: PresentationPassStats;
    if (presented) {
      // Resize the canvas backing store (the SAME object the presentation
      // context exposes) to the encoded render extent before presentation
      // (CSS positioning/size stays a DOM-layer responsibility).
      this.resizeCanvas(heightSnapshot.width, heightSnapshot.height);
      const t0 = performance.now();
      presentation = this.presentationPass.present({
        color: presentationColorBindingFromLightingPass(lightingSnapshot),
        objectId: presentationObjectIdBindingFromHeightPass(heightSnapshot),
        visibility: presentationVisibilityBindingFromShadowPass(shadowSnapshot),
        context: this.context,
        canvasFormat: this.canvasFormat,
        options: input.compositeOptions,
        debug: input.debugReadback === true,
      });
      const hostMs = performance.now() - t0;
      records.push({
        stage: "presentation",
        hostMs,
        newAllocations: presentation.newAllocations,
        bytesUploaded: 0,
        dispatches: 0,
        submissions: 1,
      });
      this.retained.presentation = presentation;
    } else {
      presentation = skippedPresentation(this.retained.presentation);
    }

    // Only a fully successful frame updates the retained frame and the
    // scheduling key: a thrown stage leaves both stale so the next render
    // recomputes conservatively.
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
    this.lastKey = key;
    this.lastEncoded = scene;
    const { frame, totals } = this.profiler.commitFrame(records, report.retained, presented);
    return {
      renderWidth: heightSnapshot.width,
      renderHeight: heightSnapshot.height,
      dpr: heightSnapshot.dpr,
      invalidation: report,
      upload,
      height,
      normal,
      shadow,
      lighting,
      presentation,
      frame,
      totals,
    };
  }

  /**
   * Re-present the LAST rendered frame without re-running the compute
   * passes (the #29 presentation-only benchmark seam). Throws before the
   * first `render()`.
   */
  present(): PresentationPassStats {
    this.assertUsable();
    const frame = this.lastFrame;
    if (frame === null) {
      throw new Error("no frame rendered: call render() before presenting");
    }
    this.resizeCanvas(frame.width, frame.height);
    const t0 = performance.now();
    const stats = this.presentationPass.present({
      color: presentationColorBindingFromLightingPass(frame.lightingPass),
      objectId: presentationObjectIdBindingFromHeightPass(frame.heightPass),
      visibility: presentationVisibilityBindingFromShadowPass(frame.shadowPass),
      context: this.context,
      canvasFormat: this.canvasFormat,
      options: frame.compositeOptions,
      debug: frame.debugReadback,
    });
    this.profiler.recordPresent(performance.now() - t0);
    return stats;
  }

  /** Cumulative profiler totals across every render()/present() call. */
  getProfile(): CumulativeProfile {
    return this.profiler.getTotals();
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
   * resources twice. Idempotent; leaves no usable stale snapshot. Resource
   * recovery is explicit: construct a fresh pipeline with a fresh
   * device/context after this call (or after device loss).
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
    this.lastKey = null;
    this.lastEncoded = null;
  }

  private resizeCanvas(width: number, height: number): void {
    if (this.context.canvas.width !== width) {
      this.context.canvas.width = width;
    }
    if (this.context.canvas.height !== height) {
      this.context.canvas.height = height;
    }
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

// -- skipped-stage stats (activity zeroed, retained allocation counts) ------

function skippedUpload(retained: UploadStats): UploadStats {
  return {
    writeCalls: 0,
    bytesUploaded: 0,
    allocationCount: retained.allocationCount,
    newAllocations: 0,
  };
}

function skippedHeight(retained: HeightPassDispatchStats): HeightPassDispatchStats {
  return {
    newAllocations: 0,
    allocationCount: retained.allocationCount,
    totalAllocationBytes: retained.totalAllocationBytes,
    maskSdfPasses: 0,
    composePasses: 0,
  };
}

function skippedFieldDispatch(retained: {
  readonly allocationCount: number;
  readonly totalAllocationBytes: number;
}): NormalPassDispatchStats & ShadowPassDispatchStats & LightingPassDispatchStats {
  return {
    newAllocations: 0,
    allocationCount: retained.allocationCount,
    totalAllocationBytes: retained.totalAllocationBytes,
    workgroupCountX: 0,
  };
}

function skippedPresentation(retained: PresentationPassStats): PresentationPassStats {
  return {
    hostEncodeMs: 0,
    configured: false,
    workSubmitted: retained.workSubmitted,
    newAllocations: 0,
    allocationCount: retained.allocationCount,
    totalAllocationBytes: retained.totalAllocationBytes,
  };
}

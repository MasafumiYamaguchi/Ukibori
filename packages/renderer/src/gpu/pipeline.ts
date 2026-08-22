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
import { GpuTimestampProfiler } from "./timestamp-profiler";
import type {
  GpuTimestampDeviceLike,
  GpuTimestampFrame,
  GpuTimestampFrameResult,
} from "./timestamp-profiler";
import { bytesEqual, computeTileGrid, planPartialScene } from "./tiles";
import type { BandRegion, PartialPlan } from "./tiles";
import { parseHeader } from "./encode";

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
 * - height-input scene change (geometry/mask/material-id/flags/extent) ->
 *   the full chain (upload through presentation), with the #32 partial
 *   geometry planning where valid. The fingerprint only accelerates the
 *   decision; the SEMANTIC classification runs on the EXACT bytes.
 * - light-direction change -> upload, shadow, lighting, presentation; the
 *   height/normal fields stay retained (their exact height-dependent
 *   inputs are re-validated by the shadow/lighting passes before reuse).
 * - light-intensity / environment / exposure / material-table VALUE
 *   changes -> upload, lighting, presentation; height, normal and shadow
 *   stay retained.
 * - normal/shadow/lighting option changes -> only the affected pass(es)
 *   and their downstream dependencies re-run (provenance is unchanged).
 * - composite/debug target changes -> presentation only.
 * - unknown ABI mutation / fingerprint collision with different bytes ->
 *   conservative full chain (a hash never authorizes a skip or a reuse).
 *
 * ## #32 conservative tile planning (partial recompute)
 *
 * When a frame invalidates the FULL chain because of a height-input scene
 * change, the deterministic planner (`gpu/tiles.ts`) diffs the EXACT
 * retained bytes against the fresh encoding (never the hash alone),
 * derives the dirty scene rect (added/removed/changed surfaces plus mask
 * references), expands it by the shadow receiver halo (down-light of every
 * changed region by the effective shadow maxDistance) and the 1-texel
 * profile/normal halo, and bins it into the explicit tile grid
 * (`input.tileSize`, default 64). The four compute passes then dispatch
 * ONLY the full-width band covering the dirty tiles (each pass packs the
 * band into its params uniform; the in-shader guard `regionEnd != 0 &&
 * g >= regionEnd` keeps dispatch padding from ever touching a retained
 * texel). Outputs outside the band stay retained and every pass shares
 * the fresh per-dispatch provenance token. Light/environment/exposure,
 * material-table VALUE, viewport and unknown mutations do NOT take the
 * partial path (height is retained, so there is no dirty geometry region);
 * it is chosen only when the band covers at most half the frame
 * (`PARTIAL_DISPATCH_RATIO`, a deterministic coverage ratio — never a
 * timing). The per-frame `planning` report exposes the decision, reason,
 * tile/dirty counts, ACTUAL height-stage candidate/culled surfaces and the
 * planner's own host wall-clock overhead.
 *
 * Each `render()` reports the invalidation reasons, the executed/skipped
 * stage sets, per-stage statistics, a per-frame profile and the cumulative
 * profiler totals. Host durations remain explicitly labeled `hostMs`;
 * when the device exposes the optional `timestamp-query` feature, the
 * asynchronous `gpuTiming` result contains actual per-pass GPU durations.
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
  /**
   * #32: explicit conservative tile size (texels) for the partial-region
   * planner. Clamped into `[TILE_SIZE_MIN, TILE_SIZE_MAX]` (8..512) with a
   * documented default of 64; benchmark code may configure it. The tile
   * grid is only used for dirty-region binning and the partial/full
   * decision — it never changes the produced pixels.
   */
  readonly tileSize?: number;
}

/**
 * #32 per-frame partial/full planning report — the deterministic tile
 * binning, dirty-region and cost-policy diagnostics plus the planner's own
 * host wall-clock time (labeled as host time, never GPU time).
 */
export interface PartialPlanReport extends PartialPlan {
  /**
   * Host wall-clock milliseconds spent inside the planner (grid, exact
   * scene diff, halo expansion, binning and the cost decision), reported
   * SEPARATELY from the submitted GPU work.
   */
  readonly planningHostMs: number;
}

export interface GpuScenePipelineFrameStats {
  readonly renderWidth: number;
  readonly renderHeight: number;
  readonly dpr: number;
  /** the #31 scheduler report: reasons + executed/skipped stages */
  readonly invalidation: InvalidationReport;
  /**
   * #32 deterministic partial/full planning report: tile size/count, dirty
   * tile/texel counts, ACTUAL height-stage candidate/culled surface counts
   * (on a partial frame the height compose shaders genuinely iterate only
   * the band's candidate ORIGINAL indices via the reused maskMeta bin; the
   * normal/shadow/lighting stages perform no per-texel surface iteration),
   * the decision and its reason, and the planner's host wall-clock
   * overhead.
   */
  readonly planning: PartialPlanReport;
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
  /**
   * Actual GPU pass durations resolved asynchronously from WebGPU timestamp
   * queries. Always fulfills: unsupported/no-work/failure are explicit
   * statuses and never masquerade as zero-duration GPU work.
   */
  readonly gpuTiming: Promise<GpuTimestampFrameResult>;
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
  private readonly timestampProfiler: GpuTimestampProfiler;
  private activeTimestampFrame: GpuTimestampFrame | null = null;
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
    this.timestampProfiler = new GpuTimestampProfiler(
      this.device as unknown as GpuTimestampDeviceLike,
    );
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
      this.activeTimestampFrame?.dispose();
      this.activeTimestampFrame = null;
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
    let key = computeFrameKey(encoded, input);
    // The scheduler receives BOTH encoded byte buffers so the semantic
    // scene classification runs on EXACT bytes, never the fingerprint alone.
    let report = reportInvalidations(
      key,
      this.lastKey,
      encoded.bytes,
      this.lastEncoded?.bytes ?? null,
      input.repaint === true,
    );
    // #32 hash-collision hardening: the stable scene fingerprint is only an
    // ACCELERATOR for the skip/partial decisions; the exact bytes authorize
    // them. A collision (fingerprint equal, bytes different) must never
    // silently preserve wrong output, so it degrades to a conservative
    // first-frame recompute.
    if (
      this.lastKey !== null &&
      this.lastEncoded !== null &&
      key.scene === this.lastKey.scene &&
      !bytesEqual(this.lastEncoded.bytes, encoded.bytes)
    ) {
      this.lastKey = null;
      key = computeFrameKey(encoded, input);
      report = reportInvalidations(key, null, encoded.bytes, null, input.repaint === true);
    }
    const executed = new Set(report.executed);
    const records: ProfilerStageRecord[] = [];
    const timestampFrame = this.timestampProfiler.beginFrame(report.executed);
    this.activeTimestampFrame = timestampFrame;

    // #32 deterministic partial/full planning. The planner is pure host
    // work: its wall-clock time is reported separately (planningHostMs,
    // labeled HOST time) and never mixed into GPU completion times.
    const planningStart = performance.now();
    const plan = this.planFrame(encoded, report, input);
    const planningHostMs = performance.now() - planningStart;
    const region: BandRegion | undefined =
      plan.mode === "partial" && plan.band !== null ? plan.band : undefined;
    const dispatchRegion = region === undefined ? undefined : { region };
    // #32 ACTUAL height-stage culling: on a partial frame the HeightPass
    // compose shaders iterate ONLY the band's candidate ORIGINAL surface
    // indices (packed into the reused maskMeta buffer); on full frames the
    // sentinel path iterates every original index.
    const heightOptions =
      plan.mode === "partial" && plan.band !== null
        ? { region: plan.band, candidates: plan.candidateIndices }
        : undefined;
    // A content-identical encoding reuses the retained bytes object so the
    // uploader bindings and the HeightPass provenance (both object-identity
    // based, #24/#28) stay valid without re-uploading. This is exactly the
    // case where the scheduler skips the upload stage; every dirty upload
    // (first frame / viewport / scene) uses the fresh encoding below. The
    // reuse is authorized by EXACT byte equality, never by the fingerprint
    // alone (#32 collision hardening).
    const scene =
      this.lastEncoded !== null &&
      this.lastKey !== null &&
      key.scene === this.lastKey.scene &&
      key.viewport === this.lastKey.viewport &&
      bytesEqual(this.lastEncoded.bytes, encoded.bytes)
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
      height = this.heightPass.dispatch(scene, bindings, {
        ...heightOptions,
        timestampWrites: timestampFrame.getTimestampWrites("height"),
      });
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
        region,
        timestampWrites: timestampFrame.getTimestampWrites("normal"),
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
        region,
        timestampWrites: timestampFrame.getTimestampWrites("shadow"),
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
        region,
        timestampWrites: timestampFrame.getTimestampWrites("lighting"),
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
        timestampWrites: timestampFrame.getTimestampWrites("presentation"),
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
    const gpuTiming = timestampFrame.resolve();
    this.activeTimestampFrame = null;
    return {
      renderWidth: heightSnapshot.width,
      renderHeight: heightSnapshot.height,
      dpr: heightSnapshot.dpr,
      invalidation: report,
      planning: { ...plan, planningHostMs },
      upload,
      height,
      normal,
      shadow,
      lighting,
      presentation,
      frame,
      totals,
      gpuTiming,
    };
  }

  /**
   * #32 deterministic partial/full planning for one frame. Only a frame
   * whose invalidation runs the FULL chain because of a height-input scene
   * change can ever take the partial path; everything else is a
   * conservative full recompute with a deterministic reason (documented
   * planner/fallback rules):
   *
   * - no retained frame, an option-only change, or a viewport/DPR change ->
   *   full
   * - light direction/intensity, exposure, environment or material-table
   *   VALUE changes -> full with the SEMANTIC reason ("light-direction-
   *   change", "light-intensity-change", "environment-change",
   *   "material-values-change"): the height stage is retained, so there is
   *   no dirty geometry region to plan
   * - unknown byte mutations -> full ("no-scene-change" / "unknown"; the
   *   classification only ever emits the conservative full chain for
   *   unknown/structural changes)
   * - pass-option changes mixed with the scene change -> full
   *   ("option-change-with-scene")
   * - the exact per-surface/mask diff yields the dirty scene rect, expanded
   *   by the shadow receiver halo and the 1-texel profile/normal halo; the
   *   dispatch band covering the dirty tiles is partial only when it covers
   *   at most PARTIAL_DISPATCH_RATIO of the frame (deterministic coverage
   *   ratio, never a timing), otherwise full ("band-coverage ...").
   *
   * The scene fingerprint is never trusted alone: `planPartialScene` diffs
   * the EXACT retained bytes against the fresh encoding.
   */
  private planFrame(
    encoded: EncodedScene,
    report: InvalidationReport,
    input: GpuScenePipelineInput,
  ): PartialPlan {
    const full = (reason: string): PartialPlan => {
      const header = parseHeader(encoded.bytes);
      const grid = computeTileGrid(header.renderWidth, header.renderHeight, input.tileSize);
      const totalTexels = header.renderWidth * header.renderHeight;
      return {
        mode: "full",
        reason,
        tileSize: grid.tileSize,
        totalTileCount: grid.tileCount,
        dirtyTileCount: 0,
        dirtyTexels: 0,
        dispatchTexels: totalTexels,
        totalTexels,
        candidateIndices: Array.from({ length: header.surfaceCount }, (_, i) => i),
        candidateSurfaceCount: header.surfaceCount,
        culledSurfaceCount: 0,
        dirtyRect: null,
        band: null,
      };
    };
    if (this.lastEncoded === null || this.lastKey === null) {
      return full("first-frame");
    }
    // Semantic non-geometry scene changes (light/env/exposure/material
    // VALUES) never take the partial path: the height stage is retained, so
    // there is no dirty geometry region to plan.
    const semanticChanges = report.reasons.filter(
      (reason): reason is "light-direction" | "light-intensity" | "environment" | "material-values" =>
        reason === "light-direction" ||
        reason === "light-intensity" ||
        reason === "environment" ||
        reason === "material-values",
    );
    if (semanticChanges.length > 0) {
      return full(semanticChanges.map((reason) => `${reason}-change`).join("+"));
    }
    if (!report.reasons.includes("scene")) {
      return full("no-scene-change");
    }
    if (report.reasons.includes("viewport")) {
      return full("viewport-change");
    }
    if (
      report.reasons.some(
        (reason) =>
          reason === "normal-options" || reason === "shadow-options" || reason === "lighting-options",
      )
    ) {
      return full("option-change-with-scene");
    }
    const header = parseHeader(encoded.bytes);
    return planPartialScene({
      prevBytes: this.lastEncoded.bytes,
      nextBytes: encoded.bytes,
      dpr: header.dpr,
      renderWidth: header.renderWidth,
      renderHeight: header.renderHeight,
      shadowOptions: input.shadowOptions,
      tileSize: input.tileSize,
    });
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
    this.activeTimestampFrame?.dispose();
    this.activeTimestampFrame = null;
    this.timestampProfiler.dispose();
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

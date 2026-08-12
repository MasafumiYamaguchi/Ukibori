import type { PipelineStage } from "./dirty";

/**
 * #31 structured pipeline profiling — cumulative and per-frame counters for
 * allocations, uploaded bytes, compute dispatches, executed/skipped passes,
 * invalidation reasons and measured durations.
 *
 * ## Timing honesty
 *
 * This profiler NEVER fabricates GPU timestamps. All durations are
 * WALL-CLOCK HOST times measured with `performance.now()` around each
 * stage's synchronous device calls (encoder creation, buffer writes and
 * `queue.submit`); they are labeled `hostMs` everywhere and are not GPU
 * execution times. `queue.onSubmittedWorkDone()` based timings live in the
 * harness/benchmark code (which labels them as such), never here.
 *
 * The profiler is a pure accumulator owned by `GpuScenePipeline`; the
 * pipeline records one entry per executed stage (and per re-presentation)
 * and reads the cumulative totals for the frame stats.
 */

export interface ProfilerStageRecord {
  /** the stage that executed */
  readonly stage: PipelineStage;
  /** wall-clock host ms around the stage's device calls (labeled: not GPU time) */
  readonly hostMs: number;
  /** GPU buffers created by the stage this frame */
  readonly newAllocations: number;
  /** host bytes uploaded by the stage this frame (upload stage only; 0 elsewhere) */
  readonly bytesUploaded: number;
  /** compute `dispatchWorkgroups` calls issued by the stage (0 for upload/presentation) */
  readonly dispatches: number;
  /** queue submissions performed by the stage (1 per executed compute/present stage) */
  readonly submissions: number;
}

/** Cumulative counters across every successful `render()`/`present()` call. */
export interface CumulativeProfile {
  /** successful `render()` calls (retained frames included) */
  readonly frames: number;
  /** `present()` calls (the #29 presentation-only seam) */
  readonly presents: number;
  /** GPU buffers created over the pipeline lifetime */
  readonly newAllocations: number;
  /** host bytes uploaded over the pipeline lifetime */
  readonly bytesUploaded: number;
  /** compute `dispatchWorkgroups` calls over the pipeline lifetime */
  readonly dispatches: number;
  /** queue submissions over the pipeline lifetime */
  readonly submissions: number;
  /** total wall-clock host ms (labeled: never GPU timestamps) */
  readonly hostMs: number;
  /** frames where NOTHING executed (byte-identical retained frames) */
  readonly skippedFrames: number;
}

/** Per-frame profile embedded in `GpuScenePipelineFrameStats`. */
export interface FrameProfile {
  /** GPU buffers created this frame (0 on a retained frame) */
  readonly newAllocations: number;
  /** host bytes uploaded this frame (0 on a retained frame) */
  readonly bytesUploaded: number;
  /** compute `dispatchWorkgroups` calls issued this frame */
  readonly dispatchCount: number;
  /** queue submissions this frame */
  readonly submissions: number;
  /**
   * Wall-clock host ms of the whole frame (labeled: never GPU timestamps;
   * `queue.onSubmittedWorkDone()` completion is NOT included).
   */
  readonly hostMs: number;
  /** per-stage wall-clock host ms, 0 for skipped stages (labeled as host time) */
  readonly passDurations: Readonly<Record<PipelineStage, number>>;
}

interface MutableTotals {
  frames: number;
  presents: number;
  newAllocations: number;
  bytesUploaded: number;
  dispatches: number;
  submissions: number;
  hostMs: number;
  skippedFrames: number;
}

export class GpuPipelineProfiler {
  private readonly totals: MutableTotals = {
    frames: 0,
    presents: 0,
    newAllocations: 0,
    bytesUploaded: 0,
    dispatches: 0,
    submissions: 0,
    hostMs: 0,
    skippedFrames: 0,
  };

  /**
   * Record one successful `render()` frame: accumulates the stage records
   * into the cumulative totals and returns the per-frame profile plus a
   * snapshot of the cumulative totals (including this frame).
   */
  commitFrame(
    records: readonly ProfilerStageRecord[],
    wasRetained: boolean,
    presented: boolean,
  ): { readonly frame: FrameProfile; readonly totals: CumulativeProfile } {
    const durations: Record<PipelineStage, number> = {
      upload: 0,
      height: 0,
      normal: 0,
      shadow: 0,
      lighting: 0,
      presentation: 0,
    };
    let newAllocations = 0;
    let bytesUploaded = 0;
    let dispatchCount = 0;
    let submissions = 0;
    let hostMs = 0;
    for (const record of records) {
      durations[record.stage] += record.hostMs;
      newAllocations += record.newAllocations;
      bytesUploaded += record.bytesUploaded;
      dispatchCount += record.dispatches;
      submissions += record.submissions;
      hostMs += record.hostMs;
    }
    this.totals.frames += 1;
    if (wasRetained) {
      this.totals.skippedFrames += 1;
    }
    this.totals.newAllocations += newAllocations;
    this.totals.bytesUploaded += bytesUploaded;
    this.totals.dispatches += dispatchCount;
    this.totals.submissions += submissions;
    this.totals.hostMs += hostMs;
    if (presented) {
      this.totals.presents += 1;
    }
    return {
      frame: {
        newAllocations,
        bytesUploaded,
        dispatchCount,
        submissions,
        hostMs,
        passDurations: durations,
      },
      totals: this.getTotals(),
    };
  }

  /** Record one `present()` (the #29 presentation-only seam). */
  recordPresent(hostMs: number): void {
    this.totals.presents += 1;
    this.totals.submissions += 1;
    this.totals.hostMs += hostMs;
  }

  /** Snapshot of the cumulative totals. */
  getTotals(): CumulativeProfile {
    return { ...this.totals };
  }
}

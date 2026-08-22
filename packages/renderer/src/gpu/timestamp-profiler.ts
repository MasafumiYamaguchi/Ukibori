import type { PipelineStage } from "./dirty";

/**
 * Optional, asynchronous GPU timestamp-query recording for the WebGPU
 * pipeline. This module deliberately does not depend on the browser WebGPU
 * globals: the small structural interfaces below are implemented by a real
 * `GPUDevice` and are straightforward to mock in Node.
 *
 * A frame owns its query set and resolve buffer. Readback buffers are also
 * unique per frame, so multiple submitted frames may be waiting on
 * `mapAsync()` concurrently without one frame overwriting another's data.
 */

/** `GPUBufferUsage` values are fixed by the WebGPU specification. */
export const GPU_TIMESTAMP_USAGE_MAP_READ = 0x0001;
export const GPU_TIMESTAMP_USAGE_COPY_SRC = 0x0004;
export const GPU_TIMESTAMP_USAGE_COPY_DST = 0x0008;
export const GPU_TIMESTAMP_USAGE_QUERY_RESOLVE = 0x0200;

/** Five timed stages, with a beginning and end query for each stage. */
export const GPU_TIMESTAMP_QUERY_COUNT = 10;
/** WebGPU query-resolve offsets are 256-byte aligned. */
export const GPU_TIMESTAMP_BUFFER_SIZE = 256;

const GPU_MAP_MODE_READ = 0x0001;
const TIMESTAMP_BYTES = 8;

export type GpuTimestampStage = Exclude<PipelineStage, "upload">;

export const GPU_TIMESTAMP_STAGES: readonly GpuTimestampStage[] = Object.freeze([
  "height",
  "normal",
  "shadow",
  "lighting",
  "presentation",
]);

export interface GpuTimestampQuerySetLike {
  destroy(): void;
}

export interface GpuTimestampBufferLike {
  mapAsync(mode: number, offset?: number, size?: number): Promise<void>;
  getMappedRange(offset?: number, size?: number): ArrayBuffer;
  unmap(): void;
  destroy(): void;
}

export interface GpuTimestampCommandBufferLike {
  readonly label?: string;
}

export interface GpuTimestampCommandEncoderLike {
  resolveQuerySet(
    querySet: GpuTimestampQuerySetLike,
    firstQuery: number,
    queryCount: number,
    destination: GpuTimestampBufferLike,
    destinationOffset: number,
  ): void;
  copyBufferToBuffer(
    source: GpuTimestampBufferLike,
    sourceOffset: number,
    destination: GpuTimestampBufferLike,
    destinationOffset: number,
    size: number,
  ): void;
  finish(): GpuTimestampCommandBufferLike;
}

/**
 * Structural, optional device surface. Missing timestamp-query operations
 * make profiling unsupported; they never make construction throw.
 */
export interface GpuTimestampDeviceLike {
  readonly features?: {
    has(feature: string): boolean;
  };
  readonly queue?: {
    submit(commandBuffers: readonly GpuTimestampCommandBufferLike[]): void;
  };
  createQuerySet?(descriptor: {
    readonly type: "timestamp";
    readonly count: number;
    readonly label?: string;
  }): GpuTimestampQuerySetLike;
  createBuffer?(descriptor: {
    readonly size: number;
    readonly usage: number;
    readonly label?: string;
  }): GpuTimestampBufferLike;
  createCommandEncoder?(descriptor?: {
    readonly label?: string;
  }): GpuTimestampCommandEncoderLike;
}

/** Modern WebGPU pass-descriptor timestamp writes. */
export interface GpuTimestampWritesLike {
  readonly querySet: GpuTimestampQuerySetLike;
  readonly beginningOfPassWriteIndex?: number;
  readonly endOfPassWriteIndex?: number;
}

export type GpuTimestampResultStatus = "ok" | "unsupported" | "no-work" | "failed";

/**
 * Timestamp result for one frame. `totalGpuMs` is the sum of the recorded
 * per-pass durations, not host submission time and not a fabricated clock.
 */
export interface GpuTimestampFrameResult {
  readonly status: GpuTimestampResultStatus;
  readonly totalGpuMs: number | null;
  readonly passGpuMs: Readonly<Partial<Record<GpuTimestampStage, number>>>;
  readonly reason?: string;
}

export interface GpuTimestampFrame {
  /** Whether this frame has real timestamp-query resources. */
  readonly supported: boolean;
  /**
   * Return timestamp writes only for a scheduled non-upload stage. The
   * returned object should be assigned directly to a compute/render pass
   * descriptor's `timestampWrites` field.
   */
  getTimestampWrites(stage: GpuTimestampStage): GpuTimestampWritesLike | undefined;
  /**
   * Resolve, copy and asynchronously map this frame's timestamp queries.
   * This promise always fulfills, including validation, submission and map
   * failures. Repeated calls share the same operation and result.
   */
  resolve(): Promise<GpuTimestampFrameResult>;
  /** Release an unresolved frame. Safe to call repeatedly. */
  dispose(): void;
}

interface CapableTimestampDevice {
  readonly queue: {
    submit(commandBuffers: readonly GpuTimestampCommandBufferLike[]): void;
  };
  createQuerySet(descriptor: {
    readonly type: "timestamp";
    readonly count: number;
    readonly label?: string;
  }): GpuTimestampQuerySetLike;
  createBuffer(descriptor: {
    readonly size: number;
    readonly usage: number;
    readonly label?: string;
  }): GpuTimestampBufferLike;
  createCommandEncoder(descriptor?: {
    readonly label?: string;
  }): GpuTimestampCommandEncoderLike;
}

const EMPTY_PASS_GPU_MS: Readonly<Partial<Record<GpuTimestampStage, number>>> =
  Object.freeze({});

/**
 * Owns optional timestamp-query capability and creates independently safe
 * per-frame recorders. A device must have been requested with the optional
 * `timestamp-query` feature for `supported` to be true.
 */
export class GpuTimestampProfiler {
  readonly supported: boolean;
  readonly unsupportedReason: string | null;

  private readonly device: CapableTimestampDevice | null;
  private readonly activeFrames = new Set<LiveTimestampFrame>();
  private disposed = false;

  constructor(device: GpuTimestampDeviceLike) {
    const capability = inspectCapability(device);
    this.device = capability.device;
    this.supported = capability.device !== null;
    this.unsupportedReason = capability.reason;
  }

  /**
   * Allocate one 10-slot query set and one aligned resolve buffer for a
   * frame. Upload is intentionally ignored because queue.writeBuffer is not
   * a pass and therefore has no pass timestampWrites descriptor.
   */
  beginFrame(executed: readonly PipelineStage[]): GpuTimestampFrame {
    if (this.disposed) {
      return new ImmediateTimestampFrame(failedResult("timestamp profiler is disposed"));
    }

    const stages = normalizeStages(executed);
    if (stages.length === 0) {
      return new ImmediateTimestampFrame({
        status: "no-work",
        totalGpuMs: null,
        passGpuMs: EMPTY_PASS_GPU_MS,
      });
    }
    if (this.device === null) {
      return new ImmediateTimestampFrame({
        status: "unsupported",
        totalGpuMs: null,
        passGpuMs: EMPTY_PASS_GPU_MS,
        reason: this.unsupportedReason ?? "timestamp-query is unavailable",
      });
    }

    let querySet: GpuTimestampQuerySetLike | null = null;
    let resolveBuffer: GpuTimestampBufferLike | null = null;
    try {
      querySet = this.device.createQuerySet({
        type: "timestamp",
        count: GPU_TIMESTAMP_QUERY_COUNT,
        label: "ukibori-frame-timestamps",
      });
      resolveBuffer = this.device.createBuffer({
        size: GPU_TIMESTAMP_BUFFER_SIZE,
        usage: GPU_TIMESTAMP_USAGE_QUERY_RESOLVE | GPU_TIMESTAMP_USAGE_COPY_SRC,
        label: "ukibori-frame-timestamp-resolve",
      });
      const frame = new LiveTimestampFrame(
        this.device,
        stages,
        querySet,
        resolveBuffer,
        () => this.activeFrames.delete(frame),
      );
      this.activeFrames.add(frame);
      return frame;
    } catch (error) {
      safeDestroy(resolveBuffer);
      safeDestroy(querySet);
      return new ImmediateTimestampFrame(
        failedResult(`timestamp resource allocation failed: ${errorMessage(error)}`),
      );
    }
  }

  /** Destroy all unresolved frame resources. Safe to call repeatedly. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const frame of [...this.activeFrames]) {
      frame.dispose();
    }
    this.activeFrames.clear();
  }
}

class ImmediateTimestampFrame implements GpuTimestampFrame {
  readonly supported = false;
  private readonly resultPromise: Promise<GpuTimestampFrameResult>;

  constructor(result: GpuTimestampFrameResult) {
    this.resultPromise = Promise.resolve(result);
  }

  getTimestampWrites(_stage: GpuTimestampStage): undefined {
    return undefined;
  }

  resolve(): Promise<GpuTimestampFrameResult> {
    return this.resultPromise;
  }

  dispose(): void {
    // No resources were allocated.
  }
}

class LiveTimestampFrame implements GpuTimestampFrame {
  readonly supported = true;

  private readonly writes = new Map<GpuTimestampStage, GpuTimestampWritesLike>();
  private readbackBuffer: GpuTimestampBufferLike | null = null;
  private resultPromise: Promise<GpuTimestampFrameResult> | null = null;
  private mapped = false;
  private released = false;
  private abortReason: string | null = null;

  constructor(
    private readonly device: CapableTimestampDevice,
    private readonly stages: readonly GpuTimestampStage[],
    private readonly querySet: GpuTimestampQuerySetLike,
    private readonly resolveBuffer: GpuTimestampBufferLike,
    private readonly onRelease: () => void,
  ) {
    stages.forEach((stage, ordinal) => {
      this.writes.set(
        stage,
        Object.freeze({
          querySet,
          beginningOfPassWriteIndex: ordinal * 2,
          endOfPassWriteIndex: ordinal * 2 + 1,
        }),
      );
    });
  }

  getTimestampWrites(stage: GpuTimestampStage): GpuTimestampWritesLike | undefined {
    if (this.released || this.resultPromise !== null) return undefined;
    return this.writes.get(stage);
  }

  resolve(): Promise<GpuTimestampFrameResult> {
    if (this.resultPromise !== null) return this.resultPromise;
    if (this.released) {
      this.resultPromise = Promise.resolve(
        failedResult(this.abortReason ?? "timestamp frame was disposed before resolve"),
      );
      return this.resultPromise;
    }
    this.resultPromise = this.resolveInternal();
    return this.resultPromise;
  }

  dispose(): void {
    if (this.released) return;
    this.abortReason = "timestamp frame was disposed before readback completed";
    // Once mapAsync has started, that async operation owns final cleanup.
    // Destroying its buffer here can race a successful map and leave it
    // mapped forever; mark it aborted and let resolveInternal's finally
    // unmap/destroy after the pending map settles.
    if (this.resultPromise === null) {
      this.releaseResources();
    }
  }

  private async resolveInternal(): Promise<GpuTimestampFrameResult> {
    const queryCount = this.stages.length * 2;
    const queryBytes = queryCount * TIMESTAMP_BYTES;
    try {
      this.readbackBuffer = this.device.createBuffer({
        size: GPU_TIMESTAMP_BUFFER_SIZE,
        usage: GPU_TIMESTAMP_USAGE_MAP_READ | GPU_TIMESTAMP_USAGE_COPY_DST,
        label: "ukibori-frame-timestamp-readback",
      });
      const encoder = this.device.createCommandEncoder({
        label: "ukibori-frame-timestamp-readback",
      });
      encoder.resolveQuerySet(this.querySet, 0, queryCount, this.resolveBuffer, 0);
      encoder.copyBufferToBuffer(
        this.resolveBuffer,
        0,
        this.readbackBuffer,
        0,
        queryBytes,
      );
      this.device.queue.submit([encoder.finish()]);

      await this.readbackBuffer.mapAsync(GPU_MAP_MODE_READ, 0, queryBytes);
      this.mapped = true;
      if (this.abortReason !== null) {
        return failedResult(this.abortReason);
      }
      const mapped = this.readbackBuffer.getMappedRange(0, queryBytes);
      return decodeTimestamps(mapped, this.stages);
    } catch (error) {
      return failedResult(`timestamp readback failed: ${errorMessage(error)}`);
    } finally {
      this.releaseResources();
    }
  }

  private releaseResources(): void {
    if (this.released) return;
    this.released = true;
    if (this.mapped && this.readbackBuffer !== null) {
      try {
        this.readbackBuffer.unmap();
      } catch {
        // Best-effort cleanup must not replace the frame result.
      }
      this.mapped = false;
    }
    safeDestroy(this.readbackBuffer);
    this.readbackBuffer = null;
    safeDestroy(this.resolveBuffer);
    safeDestroy(this.querySet);
    this.writes.clear();
    this.onRelease();
  }
}

function inspectCapability(device: GpuTimestampDeviceLike): {
  readonly device: CapableTimestampDevice | null;
  readonly reason: string | null;
} {
  try {
    if (device.features?.has("timestamp-query") !== true) {
      return { device: null, reason: "device was not created with timestamp-query" };
    }
  } catch (error) {
    return {
      device: null,
      reason: `timestamp-query feature inspection failed: ${errorMessage(error)}`,
    };
  }
  if (typeof device.createQuerySet !== "function") {
    return { device: null, reason: "device.createQuerySet is unavailable" };
  }
  if (typeof device.createBuffer !== "function") {
    return { device: null, reason: "device.createBuffer is unavailable" };
  }
  if (typeof device.createCommandEncoder !== "function") {
    return { device: null, reason: "device.createCommandEncoder is unavailable" };
  }
  if (typeof device.queue?.submit !== "function") {
    return { device: null, reason: "device.queue.submit is unavailable" };
  }
  return { device: device as CapableTimestampDevice, reason: null };
}

function normalizeStages(executed: readonly PipelineStage[]): GpuTimestampStage[] {
  const requested = new Set<PipelineStage>(executed);
  return GPU_TIMESTAMP_STAGES.filter((stage) => requested.has(stage));
}

function decodeTimestamps(
  mapped: ArrayBuffer,
  stages: readonly GpuTimestampStage[],
): GpuTimestampFrameResult {
  const requiredBytes = stages.length * 2 * TIMESTAMP_BYTES;
  if (mapped.byteLength < requiredBytes) {
    return failedResult(
      `timestamp readback returned ${mapped.byteLength} bytes; ${requiredBytes} required`,
    );
  }
  try {
    const view = new DataView(mapped);
    const passGpuMs: Partial<Record<GpuTimestampStage, number>> = {};
    let totalGpuMs = 0;
    stages.forEach((stage, ordinal) => {
      const start = view.getBigUint64(ordinal * 16, true);
      const end = view.getBigUint64(ordinal * 16 + TIMESTAMP_BYTES, true);
      if (end < start) {
        throw new Error(`${stage} timestamp ended before it began`);
      }
      const gpuMs = Number(end - start) / 1_000_000;
      if (!Number.isFinite(gpuMs)) {
        throw new Error(`${stage} timestamp duration is not finite`);
      }
      passGpuMs[stage] = gpuMs;
      totalGpuMs += gpuMs;
    });
    return {
      status: "ok",
      totalGpuMs,
      passGpuMs: Object.freeze(passGpuMs),
    };
  } catch (error) {
    return failedResult(`timestamp decode failed: ${errorMessage(error)}`);
  }
}

function failedResult(reason: string): GpuTimestampFrameResult {
  return {
    status: "failed",
    totalGpuMs: null,
    passGpuMs: EMPTY_PASS_GPU_MS,
    reason,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeDestroy(resource: { destroy(): void } | null): void {
  if (resource === null) return;
  try {
    resource.destroy();
  } catch {
    // Cleanup is intentionally idempotent and best effort.
  }
}

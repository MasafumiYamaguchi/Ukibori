import { describe, expect, it } from "vitest";
import {
  GPU_TIMESTAMP_BUFFER_SIZE,
  GPU_TIMESTAMP_QUERY_COUNT,
  GPU_TIMESTAMP_USAGE_COPY_DST,
  GPU_TIMESTAMP_USAGE_COPY_SRC,
  GPU_TIMESTAMP_USAGE_MAP_READ,
  GPU_TIMESTAMP_USAGE_QUERY_RESOLVE,
  GpuTimestampProfiler,
} from "./timestamp-profiler";
import type {
  GpuTimestampBufferLike,
  GpuTimestampCommandBufferLike,
  GpuTimestampCommandEncoderLike,
  GpuTimestampDeviceLike,
  GpuTimestampQuerySetLike,
} from "./timestamp-profiler";

class MockQuerySet implements GpuTimestampQuerySetLike {
  destroyCalls = 0;

  destroy(): void {
    this.destroyCalls += 1;
  }
}

class MockBuffer implements GpuTimestampBufferLike {
  readonly bytes: ArrayBuffer;
  readonly mapCalls: Array<readonly [number, number | undefined, number | undefined]> = [];
  unmapCalls = 0;
  destroyCalls = 0;

  constructor(
    readonly descriptor: { readonly size: number; readonly usage: number; readonly label?: string },
    private readonly rejectMap: boolean,
    private readonly mapGate?: Promise<void>,
  ) {
    this.bytes = new ArrayBuffer(descriptor.size);
  }

  async mapAsync(mode: number, offset?: number, size?: number): Promise<void> {
    this.mapCalls.push([mode, offset, size]);
    if (this.rejectMap) throw new Error("map rejected");
    await this.mapGate;
  }

  getMappedRange(offset = 0, size = this.bytes.byteLength - offset): ArrayBuffer {
    return this.bytes.slice(offset, offset + size);
  }

  unmap(): void {
    this.unmapCalls += 1;
  }

  destroy(): void {
    this.destroyCalls += 1;
  }
}

interface ResolveCall {
  readonly querySet: MockQuerySet;
  readonly firstQuery: number;
  readonly queryCount: number;
  readonly destination: MockBuffer;
  readonly destinationOffset: number;
}

interface CopyCall {
  readonly source: MockBuffer;
  readonly sourceOffset: number;
  readonly destination: MockBuffer;
  readonly destinationOffset: number;
  readonly size: number;
}

class MockEncoder implements GpuTimestampCommandEncoderLike {
  readonly resolveCalls: ResolveCall[] = [];
  readonly copyCalls: CopyCall[] = [];
  finishCalls = 0;

  constructor(private readonly timestamps: readonly bigint[]) {}

  resolveQuerySet(
    querySet: GpuTimestampQuerySetLike,
    firstQuery: number,
    queryCount: number,
    destination: GpuTimestampBufferLike,
    destinationOffset: number,
  ): void {
    this.resolveCalls.push({
      querySet: querySet as MockQuerySet,
      firstQuery,
      queryCount,
      destination: destination as MockBuffer,
      destinationOffset,
    });
    const view = new DataView((destination as MockBuffer).bytes);
    for (let index = 0; index < queryCount; index++) {
      view.setBigUint64(destinationOffset + index * 8, this.timestamps[index] ?? 0n, true);
    }
  }

  copyBufferToBuffer(
    source: GpuTimestampBufferLike,
    sourceOffset: number,
    destination: GpuTimestampBufferLike,
    destinationOffset: number,
    size: number,
  ): void {
    const src = source as MockBuffer;
    const dst = destination as MockBuffer;
    this.copyCalls.push({ source: src, sourceOffset, destination: dst, destinationOffset, size });
    new Uint8Array(dst.bytes, destinationOffset, size).set(
      new Uint8Array(src.bytes, sourceOffset, size),
    );
  }

  finish(): GpuTimestampCommandBufferLike {
    this.finishCalls += 1;
    return { label: "mock-timestamp-command-buffer" };
  }
}

function mockDevice(options?: {
  readonly timestamps?: readonly bigint[];
  readonly rejectMap?: boolean;
  readonly throwOnQuerySet?: boolean;
  readonly mapGate?: Promise<void>;
}) {
  const querySets: MockQuerySet[] = [];
  const buffers: MockBuffer[] = [];
  const encoders: MockEncoder[] = [];
  const submissions: Array<readonly GpuTimestampCommandBufferLike[]> = [];
  const device: GpuTimestampDeviceLike = {
    features: { has: (feature) => feature === "timestamp-query" },
    queue: {
      submit: (commandBuffers) => submissions.push(commandBuffers),
    },
    createQuerySet: () => {
      if (options?.throwOnQuerySet) throw new Error("query allocation failed");
      const querySet = new MockQuerySet();
      querySets.push(querySet);
      return querySet;
    },
    createBuffer: (descriptor) => {
      const buffer = new MockBuffer(
        descriptor,
        options?.rejectMap === true,
        options?.mapGate,
      );
      buffers.push(buffer);
      return buffer;
    },
    createCommandEncoder: () => {
      const encoder = new MockEncoder(options?.timestamps ?? []);
      encoders.push(encoder);
      return encoder;
    },
  };
  return { device, querySets, buffers, encoders, submissions };
}

describe("GpuTimestampProfiler", () => {
  it("reports unsupported explicitly and allocates nothing", async () => {
    const profiler = new GpuTimestampProfiler({
      features: { has: () => false },
    });
    const frame = profiler.beginFrame(["normal"]);

    expect(profiler.supported).toBe(false);
    expect(frame.supported).toBe(false);
    expect(frame.getTimestampWrites("normal")).toBeUndefined();
    await expect(frame.resolve()).resolves.toMatchObject({
      status: "unsupported",
      totalGpuMs: null,
      passGpuMs: {},
    });
  });

  it("reports a no-work frame without requiring timestamp support", async () => {
    const profiler = new GpuTimestampProfiler({});
    const frame = profiler.beginFrame(["upload"]);

    await expect(frame.resolve()).resolves.toEqual({
      status: "no-work",
      totalGpuMs: null,
      passGpuMs: {},
    });
  });

  it("allocates twelve query slots and canonical pass timestampWrites", () => {
    const mock = mockDevice();
    const profiler = new GpuTimestampProfiler(mock.device);
    const frame = profiler.beginFrame([
      "presentation",
      "upload",
      "shadow",
      "height",
      "shadow",
    ]);

    expect(mock.querySets).toHaveLength(1);
    expect(mock.buffers).toHaveLength(1);
    expect(mock.buffers[0].descriptor).toMatchObject({
      size: GPU_TIMESTAMP_BUFFER_SIZE,
      usage: GPU_TIMESTAMP_USAGE_QUERY_RESOLVE | GPU_TIMESTAMP_USAGE_COPY_SRC,
    });
    expect(frame.getTimestampWrites("height")).toEqual({
      querySet: mock.querySets[0],
      beginningOfPassWriteIndex: 0,
      endOfPassWriteIndex: 1,
    });
    expect(frame.getTimestampWrites("shadow")).toEqual({
      querySet: mock.querySets[0],
      beginningOfPassWriteIndex: 2,
      endOfPassWriteIndex: 3,
    });
    expect(frame.getTimestampWrites("presentation")).toEqual({
      querySet: mock.querySets[0],
      beginningOfPassWriteIndex: 4,
      endOfPassWriteIndex: 5,
    });
    expect(frame.getTimestampWrites("normal")).toBeUndefined();
    expect(GPU_TIMESTAMP_QUERY_COUNT).toBe(12);

    frame.dispose();
    frame.dispose();
    expect(mock.querySets[0].destroyCalls).toBe(1);
    expect(mock.buffers[0].destroyCalls).toBe(1);
  });

  it("resolves, copies, maps u64 nanoseconds and sums per-pass GPU ms", async () => {
    const mock = mockDevice({
      timestamps: [1_000_000n, 3_500_000n, 10_000_000n, 14_000_000n],
    });
    const profiler = new GpuTimestampProfiler(mock.device);
    const frame = profiler.beginFrame(["height", "lighting"]);

    const first = frame.resolve();
    expect(frame.resolve()).toBe(first);
    await expect(first).resolves.toEqual({
      status: "ok",
      totalGpuMs: 6.5,
      passGpuMs: { height: 2.5, lighting: 4 },
    });

    expect(mock.encoders).toHaveLength(1);
    expect(mock.encoders[0].resolveCalls[0]).toMatchObject({
      querySet: mock.querySets[0],
      firstQuery: 0,
      queryCount: 4,
      destination: mock.buffers[0],
      destinationOffset: 0,
    });
    expect(mock.encoders[0].copyCalls[0]).toMatchObject({
      source: mock.buffers[0],
      destination: mock.buffers[1],
      sourceOffset: 0,
      destinationOffset: 0,
      size: 32,
    });
    expect(mock.buffers[1].descriptor).toMatchObject({
      size: GPU_TIMESTAMP_BUFFER_SIZE,
      usage: GPU_TIMESTAMP_USAGE_MAP_READ | GPU_TIMESTAMP_USAGE_COPY_DST,
    });
    expect(mock.buffers[1].mapCalls).toEqual([[1, 0, 32]]);
    expect(mock.buffers[1].unmapCalls).toBe(1);
    expect(mock.buffers[1].destroyCalls).toBe(1);
    expect(mock.buffers[0].destroyCalls).toBe(1);
    expect(mock.querySets[0].destroyCalls).toBe(1);
    expect(mock.submissions).toHaveLength(1);
  });

  it("uses unique query, resolve and readback resources for concurrent frames", async () => {
    const mock = mockDevice({ timestamps: [0n, 1_000_000n] });
    const profiler = new GpuTimestampProfiler(mock.device);
    const firstFrame = profiler.beginFrame(["normal"]);
    const secondFrame = profiler.beginFrame(["shadow"]);

    const first = firstFrame.resolve();
    const second = secondFrame.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toMatchObject({ status: "ok", passGpuMs: { normal: 1 } });
    expect(secondResult).toMatchObject({ status: "ok", passGpuMs: { shadow: 1 } });
    expect(mock.querySets[0]).not.toBe(mock.querySets[1]);
    expect(mock.buffers[0]).not.toBe(mock.buffers[1]);
    expect(mock.buffers[2]).not.toBe(mock.buffers[3]);
  });

  it("fulfills with failed on allocation and map errors instead of rejecting", async () => {
    const allocationMock = mockDevice({ throwOnQuerySet: true });
    const allocationFrame = new GpuTimestampProfiler(allocationMock.device).beginFrame(["height"]);
    await expect(allocationFrame.resolve()).resolves.toMatchObject({
      status: "failed",
      reason: expect.stringContaining("query allocation failed"),
    });

    const mapMock = mockDevice({ rejectMap: true });
    const mapFrame = new GpuTimestampProfiler(mapMock.device).beginFrame(["height"]);
    await expect(mapFrame.resolve()).resolves.toMatchObject({
      status: "failed",
      reason: expect.stringContaining("map rejected"),
    });
    expect(mapMock.buffers[1].destroyCalls).toBe(1);
    expect(mapMock.buffers[0].destroyCalls).toBe(1);
    expect(mapMock.querySets[0].destroyCalls).toBe(1);
  });

  it("disposes unresolved frames and the profiler idempotently", async () => {
    const mock = mockDevice();
    const profiler = new GpuTimestampProfiler(mock.device);
    const frame = profiler.beginFrame(["presentation"]);

    profiler.dispose();
    profiler.dispose();
    expect(mock.querySets[0].destroyCalls).toBe(1);
    expect(mock.buffers[0].destroyCalls).toBe(1);
    await expect(frame.resolve()).resolves.toMatchObject({
      status: "failed",
      reason: expect.stringContaining("disposed"),
    });
    await expect(profiler.beginFrame(["height"]).resolve()).resolves.toMatchObject({
      status: "failed",
      reason: expect.stringContaining("disposed"),
    });
  });

  it("lets an in-flight map own cleanup when disposal races readback", async () => {
    let releaseMap!: () => void;
    const mapGate = new Promise<void>((resolve) => {
      releaseMap = resolve;
    });
    const mock = mockDevice({
      timestamps: [0n, 1_000_000n],
      mapGate,
    });
    const profiler = new GpuTimestampProfiler(mock.device);
    const frame = profiler.beginFrame(["normal"]);

    const result = frame.resolve();
    frame.dispose();
    expect(mock.buffers[1].destroyCalls).toBe(0);

    releaseMap();
    await expect(result).resolves.toMatchObject({
      status: "failed",
      reason: expect.stringContaining("disposed"),
    });
    expect(mock.buffers[1].unmapCalls).toBe(1);
    expect(mock.buffers[1].destroyCalls).toBe(1);
    expect(mock.buffers[0].destroyCalls).toBe(1);
    expect(mock.querySets[0].destroyCalls).toBe(1);
  });
});

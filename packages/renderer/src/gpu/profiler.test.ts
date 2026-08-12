import { describe, expect, it } from "vitest";
import { GpuPipelineProfiler } from "./profiler";
import type { ProfilerStageRecord } from "./profiler";

function record(partial: Partial<ProfilerStageRecord>): ProfilerStageRecord {
  return {
    stage: "upload",
    hostMs: 1,
    newAllocations: 0,
    bytesUploaded: 0,
    dispatches: 0,
    submissions: 1,
    ...partial,
  };
}

describe("GpuPipelineProfiler — cumulative and per-frame counters", () => {
  it("starts at zero totals", () => {
    const profiler = new GpuPipelineProfiler();
    expect(profiler.getTotals()).toEqual({
      frames: 0,
      presents: 0,
      newAllocations: 0,
      bytesUploaded: 0,
      dispatches: 0,
      submissions: 0,
      hostMs: 0,
      skippedFrames: 0,
    });
  });

  it("accumulates per-frame stage records into cumulative totals", () => {
    const profiler = new GpuPipelineProfiler();
    // the upload stage performs only writeBuffer calls (submissions 0);
    // the height stage owns one queue.submit (submissions 1)
    const first = profiler.commitFrame(
      [
        record({ stage: "upload", hostMs: 1.5, bytesUploaded: 400, submissions: 0 }),
        record({ stage: "height", hostMs: 2, newAllocations: 8, dispatches: 6 }),
      ],
      false,
      false,
    );
    expect(first.frame.newAllocations).toBe(8);
    expect(first.frame.bytesUploaded).toBe(400);
    expect(first.frame.dispatchCount).toBe(6);
    expect(first.frame.submissions).toBe(1);
    expect(first.frame.hostMs).toBeCloseTo(3.5, 6);
    expect(first.frame.passDurations.upload).toBeCloseTo(1.5, 6);
    expect(first.frame.passDurations.height).toBeCloseTo(2, 6);
    expect(first.frame.passDurations.presentation).toBe(0);
    expect(first.totals.frames).toBe(1);
    expect(first.totals.newAllocations).toBe(8);
    expect(first.totals.bytesUploaded).toBe(400);
    expect(first.totals.dispatches).toBe(6);
    expect(first.totals.skippedFrames).toBe(0);

    const second = profiler.commitFrame(
      [record({ stage: "lighting", hostMs: 0.5, newAllocations: 1, dispatches: 1 })],
      true,
      true,
    );
    // per-frame profile is for THIS frame only
    expect(second.frame.newAllocations).toBe(1);
    expect(second.frame.bytesUploaded).toBe(0);
    // cumulative totals include both frames
    expect(second.totals.frames).toBe(2);
    expect(second.totals.newAllocations).toBe(9);
    expect(second.totals.skippedFrames).toBe(1);
    expect(second.totals.presents).toBe(1);
    expect(second.totals.submissions).toBe(2); // 1 (frame 1) + 1 (frame 2 record)
  });

  it("counts re-presentations via recordPresent", () => {
    const profiler = new GpuPipelineProfiler();
    profiler.commitFrame([record({ stage: "presentation", hostMs: 1 })], false, true);
    profiler.recordPresent(0.25);
    const totals = profiler.getTotals();
    expect(totals.presents).toBe(2);
    expect(totals.submissions).toBe(2);
    expect(totals.hostMs).toBeCloseTo(1.25, 6);
  });

  it("labels every duration as host wall-clock time (no GPU timestamps fabricated)", () => {
    const profiler = new GpuPipelineProfiler();
    const { frame } = profiler.commitFrame(
      [
        record({ stage: "normal", hostMs: 0.75 }),
        record({ stage: "shadow", hostMs: 1.25 }),
      ],
      false,
      false,
    );
    // the only time-bearing fields are the labeled hostMs values
    expect(frame.hostMs).toBeCloseTo(2, 6);
    expect(frame.passDurations.normal).toBeCloseTo(0.75, 6);
    expect(frame.passDurations.shadow).toBeCloseTo(1.25, 6);
    for (const stage of ["upload", "height", "lighting", "presentation"] as const) {
      expect(frame.passDurations[stage]).toBe(0);
    }
  });
});

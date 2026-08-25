import { describe, expect, it } from "vitest";
import { createScene } from "../scene";
import type { Scene } from "../scene";
import type {
  GpuBindGroupEntryLike,
  GpuBindGroupLayoutEntryLike,
  GpuBindGroupLayoutLike,
  GpuBindGroupLike,
  GpuComputePipelineLike,
  GpuLimitsLike,
  GpuPipelineLayoutLike,
  GpuShaderModuleLike,
} from "./height-pass";
import { GpuScenePipeline } from "./pipeline";
import type { GpuPipelineDeviceLike } from "./pipeline";
import type {
  GpuCanvasConfigurationLike,
  GpuCanvasContextLike,
  GpuPresentationEncoderLike,
  GpuPresentationLimitsLike,
  GpuRenderPassEncoderLike,
  GpuRenderPipelineLike,
  GpuTextureLike,
} from "./presentation-pass";
import type { GpuBufferLike } from "./uploader";

// ---------------------------------------------------------------------------
// Full structural mock: implements the exact GpuComputeDeviceLike +
// GpuPresentationDeviceLike surface the real GPUDevice is cast into.
// ---------------------------------------------------------------------------

class MockBuffer implements GpuBufferLike {
  destroyed = false;
  constructor(
    readonly size: number,
    readonly usage: number,
    readonly label?: string,
  ) {}
  destroy(): void {
    this.destroyed = true;
  }
}

class MockTexture implements GpuTextureLike {
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}
  createView(): { label: string } {
    return { label: "ukibori-mock-view" };
  }
}

class MockRenderPass implements GpuRenderPassEncoderLike {
  readonly log: string[] = [];
  setPipeline(): void {
    this.log.push("setPipeline");
  }
  setBindGroup(index: number): void {
    this.log.push(`setBindGroup(${index})`);
  }
  draw(vertexCount: number): void {
    this.log.push(`draw(${vertexCount})`);
  }
  end(): void {
    this.log.push("end");
  }
}

class MockFullEncoder implements GpuPresentationEncoderLike {
  readonly log: string[] = [];
  beginComputePass(): { setPipeline(): void; setBindGroup(): void; dispatchWorkgroups(): void; end(): void } {
    // The same proven compute-pass mock behavior as the existing pass
    // tests: the full #25/#26/#27/#28 chain runs through this encoder.
    this.log.push("beginComputePass");
    const log = this.log;
    return {
      setPipeline(): void {
        log.push("setPipeline");
      },
      setBindGroup(): void {
        log.push("setBindGroup");
      },
      dispatchWorkgroups(): void {
        log.push("dispatch");
      },
      end(): void {
        log.push("end");
      },
    };
  }
  beginRenderPass(desc: unknown): GpuRenderPassEncoderLike {
    const pass = new MockRenderPass();
    this.log.push(`beginRenderPass(${String((desc as { colorAttachments?: unknown[] }).colorAttachments?.length ?? 0)} attachment)`);
    return pass;
  }
  finish(): { label?: string } {
    return { label: "mock" };
  }
}

class MockCanvasContext implements GpuCanvasContextLike {
  readonly canvas: { width: number; height: number };
  readonly configured: GpuCanvasConfigurationLike[] = [];
  unconfigured = false;
  constructor(width: number, height: number) {
    this.canvas = { width, height };
  }
  configure(desc: GpuCanvasConfigurationLike): void {
    this.configured.push(desc);
  }
  unconfigure(): void {
    this.unconfigured = true;
  }
  getCurrentTexture(): GpuTextureLike {
    return new MockTexture(this.canvas.width, this.canvas.height);
  }
}

class MockFullDevice {
  readonly limits: GpuLimitsLike & GpuPresentationLimitsLike;
  readonly encoders: MockFullEncoder[] = [];
  readonly submits: unknown[][] = [];
  readonly writes: Array<{ buffer: MockBuffer; bytes: Uint8Array }> = [];
  readonly created: MockBuffer[] = [];
  readonly renderPipelineFormats: string[] = [];
  readonly bindGroups: Array<{ entries: readonly GpuBindGroupEntryLike[] }> = [];
  /** one-shot: the next createCommandEncoder call throws (mid-frame failure injection) */
  failNextEncoder = false;
  private resolveLost: ((value: unknown) => void) | null = null;
  readonly lost: Promise<unknown>;

  constructor(limits: Partial<GpuLimitsLike & GpuPresentationLimitsLike> = {}) {
    this.limits = {
      maxStorageBufferBindingSize: 1 << 28,
      maxBufferSize: 1 << 28,
      maxUniformBufferBindingSize: 16 * 1024,
      maxComputeWorkgroupSizeX: 256,
      maxComputeInvocationsPerWorkgroup: 256,
      maxComputeWorkgroupsPerDimension: 65535,
      maxStorageBuffersPerShaderStage: 8,
      ...limits,
    };
    this.lost = new Promise((resolveLost) => {
      this.resolveLost = resolveLost;
    });
  }

  triggerLoss(): void {
    this.resolveLost?.(undefined);
  }

  readonly queue = {
    writeBuffer: (buffer: GpuBufferLike, _offset: number, source: Uint8Array): void => {
      this.writes.push({ buffer: buffer as MockBuffer, bytes: source.slice() });
    },
    submit: (commandBuffers: readonly unknown[]): void => {
      this.submits.push([...commandBuffers]);
    },
  };

  createBuffer(desc: { size: number; usage: number; label?: string }): GpuBufferLike {
    const buffer = new MockBuffer(desc.size, desc.usage, desc.label);
    this.created.push(buffer);
    return buffer;
  }

  createShaderModule(desc: { code: string; label?: string }): GpuShaderModuleLike {
    return { label: desc.label };
  }

  createComputePipeline(desc: { label?: string }): GpuComputePipelineLike {
    return { label: desc.label };
  }

  createRenderPipeline(desc: {
    label?: string;
    fragment: { targets: readonly { format: string; label?: string }[] };
  }): GpuRenderPipelineLike {
    this.renderPipelineFormats.push(desc.fragment.targets[0].format);
    return { label: desc.label };
  }

  createBindGroupLayout(desc: { label?: string }): GpuBindGroupLayoutLike {
    return { label: desc.label };
  }

  createPipelineLayout(desc: { label?: string }): GpuPipelineLayoutLike {
    return { label: desc.label };
  }

  createBindGroup(desc: { label?: string; entries: readonly GpuBindGroupEntryLike[] }): GpuBindGroupLike {
    this.bindGroups.push({ entries: [...desc.entries] });
    return { label: desc.label };
  }

  createCommandEncoder(): MockFullEncoder {
    if (this.failNextEncoder) {
      // one-shot failure injection: the next createCommandEncoder call
      // throws (used to simulate a mid-frame stage failure)
      this.failNextEncoder = false;
      throw new Error("injected encoder failure");
    }
    const encoder = new MockFullEncoder();
    this.encoders.push(encoder);
    return encoder;
  }
}

// ---------------------------------------------------------------------------

function sceneA(): Scene {
  return createScene({
    width: 100,
    height: 80,
    surfaces: [
      {
        id: "a",
        position: { x: 10, y: 10 },
        size: { x: 40, y: 30 },
        elevation: 2,
        thickness: 2,
        shape: { kind: "roundedRect", radius: 0 },
        profile: { kind: "flat" },
        material: "silicone",
        castsShadow: true,
        receivesShadow: true,
      },
    ],
    light: { direction: { x: -0.70710678, y: 0, z: 0.70710678 }, intensity: 1 },
  });
}

function sceneB(): Scene {
  return createScene({
    width: 64,
    height: 48,
    surfaces: [
      {
        id: "b",
        position: { x: 4, y: 4 },
        size: { x: 20, y: 20 },
        elevation: 5,
        thickness: 1,
        shape: { kind: "roundedRect", radius: 0 },
        profile: { kind: "flat" },
        material: "metal",
        castsShadow: true,
        receivesShadow: true,
      },
    ],
    light: { direction: { x: 0, y: 0, z: 1 }, intensity: 1 },
  });
}

function setup() {
  const device = new MockFullDevice();
  const context = new MockCanvasContext(0, 0);
  const pipeline = new GpuScenePipeline(
    device as unknown as GpuPipelineDeviceLike,
    context,
    "rgba8unorm",
  );
  return { device, context, pipeline };
}

// ---------------------------------------------------------------------------

describe("GpuScenePipeline — full-chain orchestrator", () => {
  it("runs encode -> upload -> height -> normal -> shadow -> lighting -> presentation in order", () => {
    const { device, context, pipeline } = setup();
    const stats = pipeline.render({ scene: sceneA(), dpr: 1 });
    // five stage encoders in order: height, normal, shadow, lighting,
    // presentation (each pass owns one encoder + one submission)
    expect(device.encoders).toHaveLength(5);
    const heightEnc = device.encoders[0];
    expect(heightEnc.log[0]).toBe("beginComputePass");
    // compute passes run before the render pass of the final stage
    const allPasses: string[] = device.encoders.flatMap((encoder) => encoder.log);
    const renderPasses = allPasses.filter((entry) => entry.startsWith("beginRenderPass")).length;
    expect(renderPasses).toBe(1); // only the presentation stage uses a render pass
    // the four compute stages each begin with compute passes; the final
    // presentation stage begins with the render pass (height/normal/shadow/
    // lighting may begin a compute pass several times per dispatch)
    for (const encoder of device.encoders.slice(0, 4)) {
      expect(encoder.log[0]).toBe("beginComputePass");
    }
    expect(device.encoders[4].log[0]).toBe("beginRenderPass(1 attachment)");
    expect(device.submits).toHaveLength(5); // one queue submission per stage
    // the canvas backing store exposed by the presentation context was
    // resized to the encoded render extent (same object, no divergence)
    expect(context.canvas.width).toBe(100);
    expect(context.canvas.height).toBe(80);
    expect(context.configured).toHaveLength(1);
    expect(context.configured[0].format).toBe("rgba8unorm");
    // structured per-stage stats, no host pixel copies
    expect(stats.renderWidth).toBe(100);
    expect(stats.renderHeight).toBe(80);
    expect(stats.dpr).toBe(1);
    expect(stats.upload.allocationCount).toBe(5);
    expect(stats.height.composePasses).toBe(5);
    expect(stats.normal.allocationCount).toBe(2);
    expect(stats.shadow.allocationCount).toBe(2);
    expect(stats.lighting.allocationCount).toBe(4);
    expect(stats.presentation.allocationCount).toBe(1);
  });

  it("derives every downstream binding with current per-frame provenance", () => {
    const { device, pipeline } = setup();
    pipeline.render({ scene: sceneA(), dpr: 1 });
    const first = pipeline.getSnapshot();
    pipeline.render({ scene: sceneB(), dpr: 1 });
    const second = pipeline.getSnapshot();
    expect(first.heightPass.provenance).not.toBe(second.heightPass.provenance);
    // the snapshot is current: lighting provenance matches this frame's height
    expect(second.lightingPass.provenance).toBe(second.heightPass.provenance);
    expect(second.normalPass.provenance).toBe(second.heightPass.provenance);
    expect(second.shadowPass.provenance).toBe(second.heightPass.provenance);
    expect(second.width).toBe(64);
    expect(second.height).toBe(48);
    expect(second.dpr).toBe(1);
    // the presentation bind group references THIS frame's lighting output
    // with THIS frame's extent (pass-level allocations may be reused across
    // frames — the caching contract — so the per-frame identity is the
    // provenance object and the bound byte sizes, not buffer object identity)
    const presentationGroup = device.bindGroups.at(-1)!;
    const colorEntry = presentationGroup.entries[1];
    expect(colorEntry.resource.buffer).toBe(second.lightingPass.color.buffer);
    expect(colorEntry.resource.size).toBe(second.lightingPass.color.byteLength);
    expect(colorEntry.resource.size).toBe(64 * 48 * 4);
    const objectIdEntry = presentationGroup.entries[2];
    expect(objectIdEntry.resource.buffer).toBe(second.heightPass.outputs.objectId.buffer);
    expect(objectIdEntry.resource.size).toBe(second.heightPass.outputs.objectId.byteLength);
    const visibilityEntry = presentationGroup.entries[3];
    expect(visibilityEntry.resource.buffer).toBe(second.shadowPass.output.buffer);
    expect(visibilityEntry.resource.size).toBe(second.shadowPass.output.byteLength);
    expect(device.renderPipelineFormats).toEqual(["rgba8unorm"]);
  });

  it("resizes the canvas backing store on every frame and reuses the presentation", () => {
    const { device, context, pipeline } = setup();
    pipeline.render({ scene: sceneA(), dpr: 1 }); // 100x80
    expect(context.canvas.width).toBe(100);
    expect(context.canvas.height).toBe(80);
    pipeline.render({ scene: sceneB(), dpr: 2 }); // 128x96 at dpr 2
    expect(context.canvas.width).toBe(128);
    expect(context.canvas.height).toBe(96);
    expect(context.configured).toHaveLength(1); // config reused across sizes
    expect(device.submits).toHaveLength(10);
  });

  it("forwards composite options and the test-only debug flag to the presentation pass", () => {
    const { pipeline } = setup();
    pipeline.render({
      scene: sceneA(),
      dpr: 1,
      compositeOptions: { shadowColor: [255, 0, 0], shadowAlpha: 0.5 },
      debugReadback: true,
    });
    const snapshot = pipeline.getSnapshot();
    expect(snapshot.presentationPass.composite).toEqual({
      shadowColor: [255, 0, 0],
      shadowAlpha: 0.5,
    });
    expect(snapshot.presentationPass.debug).toBe(true);
  });

  it("presents the last rendered frame without re-running the compute passes", () => {
    const { device, pipeline } = setup();
    pipeline.render({ scene: sceneA(), dpr: 1 });
    const submissionsAfterRender = device.submits.length;
    const stats = pipeline.present();
    expect(device.submits.length).toBe(submissionsAfterRender + 1);
    expect(stats.workSubmitted).toBe(2);
    expect(stats.configured).toBe(false); // config reused
  });

  it("throws on present() before any render() and on getSnapshot() before/after", () => {
    const { pipeline } = setup();
    expect(() => pipeline.present()).toThrow(/no frame rendered/);
    expect(() => pipeline.getSnapshot()).toThrow(/no frame rendered/);
    pipeline.render({ scene: sceneA(), dpr: 1 });
    pipeline.dispose();
    expect(() => pipeline.render({ scene: sceneA(), dpr: 1 })).toThrow(/disposed/);
    expect(() => pipeline.getSnapshot()).toThrow(/disposed/);
    pipeline.dispose(); // idempotent
  });

  it("disposes in reverse ownership order and never destroys the foreign canvas", () => {
    const { context, pipeline } = setup();
    pipeline.render({ scene: sceneA(), dpr: 1 });
    pipeline.dispose();
    expect(context.unconfigured).toBe(true);
    expect(() => pipeline.getSnapshot()).toThrow(/disposed/);
  });

  it("fails closed after device loss without submitting more work", async () => {
    const { device, pipeline } = setup();
    pipeline.render({ scene: sceneA(), dpr: 1 });
    device.triggerLoss();
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 0));
    const submissions = device.submits.length;
    expect(() => pipeline.render({ scene: sceneA(), dpr: 1 })).toThrow(/device is lost/);
    expect(() => pipeline.present()).toThrow(/device is lost/);
    expect(() => pipeline.getSnapshot()).toThrow(/device is lost/);
    expect(device.submits.length).toBe(submissions);
  });
});

describe("GpuScenePipeline — #31 dirty-pass scheduling and retained resources", () => {
  const writePayloads = (device: MockFullDevice): number[][] =>
    device.writes.map((write) => Array.from(write.bytes));

  it("runs the full chain on the first frame and reports first-frame invalidation", () => {
    const { device, pipeline } = setup();
    const stats = pipeline.render({ scene: sceneA(), dpr: 1 });
    expect(stats.invalidation.reasons).toEqual(["first-frame"]);
    expect(stats.invalidation.executed).toEqual([
      "upload",
      "height",
      "normal",
      "shadow",
      "reconstruction",
      "lighting",
      "presentation",
    ]);
    expect(stats.invalidation.skipped).toEqual([]);
    expect(stats.invalidation.retained).toBe(false);
    expect(device.submits).toHaveLength(5);
    // per-frame profile: one dispatch per compute pass (height = sdf(0) +
    // compose(5); normal/shadow/lighting = 1 each) and one queue.submit per
    // stage that actually submits (upload only writeBuffer -> 0)
    expect(stats.frame.dispatchCount).toBe(8);
    expect(stats.frame.submissions).toBe(5);
    expect(stats.frame.bytesUploaded).toBeGreaterThan(0);
    expect(stats.frame.newAllocations).toBeGreaterThan(0);
    expect(stats.totals.frames).toBe(1);
    expect(stats.totals.dispatches).toBe(8);
    expect(stats.totals.submissions).toBe(5);
    // all durations are labeled host (wall-clock) values
    for (const stage of ["upload", "height", "normal", "shadow", "lighting", "presentation"] as const) {
      expect(stats.frame.passDurations[stage]).toBeGreaterThanOrEqual(0);
    }
  });

  it("retains every resource on a byte-identical repeated frame (no upload, compute or presentation)", () => {
    const { device, context, pipeline } = setup();
    const first = pipeline.render({ scene: sceneA(), dpr: 1 });
    const firstSnapshot = pipeline.getSnapshot();
    const submits = device.submits.length;
    const writes = device.writes.length;
    const created = device.created.length;

    const second = pipeline.render({ scene: sceneA(), dpr: 1 });
    expect(second.invalidation.reasons).toEqual([]);
    expect(second.invalidation.retained).toBe(true);
    expect(second.invalidation.executed).toEqual([]);
    expect(second.invalidation.skipped).toEqual([
      "upload",
      "height",
      "normal",
      "shadow",
      "reconstruction",
      "lighting",
      "presentation",
    ]);
    // zero GPU work: no submissions, no writes, no allocations
    expect(device.submits.length).toBe(submits);
    expect(device.writes.length).toBe(writes);
    expect(device.created.length).toBe(created);
    // zeroed per-stage activity with retained allocation counts
    expect(second.upload.writeCalls).toBe(0);
    expect(second.upload.bytesUploaded).toBe(0);
    expect(second.upload.allocationCount).toBe(first.upload.allocationCount);
    expect(second.height.composePasses).toBe(0);
    expect(second.height.allocationCount).toBe(first.height.allocationCount);
    expect(second.frame.dispatchCount).toBe(0);
    expect(second.frame.bytesUploaded).toBe(0);
    // the canvas keeps the previously presented frame untouched
    expect(context.canvas.width).toBe(100);
    expect(context.canvas.height).toBe(80);
    // the retained snapshot is IDENTICAL (same buffers, same provenance token)
    const secondSnapshot = pipeline.getSnapshot();
    expect(secondSnapshot.heightPass.provenance).toBe(firstSnapshot.heightPass.provenance);
    expect(secondSnapshot.lightingPass.color.buffer).toBe(firstSnapshot.lightingPass.color.buffer);
    expect(secondSnapshot.shadowPass.output.buffer).toBe(firstSnapshot.shadowPass.output.buffer);
    // cumulative profiling: one retained (skipped) frame counted, no dispatches
    expect(second.totals.frames).toBe(2);
    expect(second.totals.dispatches).toBe(first.totals.dispatches);
    expect(second.totals.skippedFrames).toBe(1);
  });

  it("re-presents a retained frame from retained outputs when repaint is requested", () => {
    const { device, pipeline } = setup();
    pipeline.render({ scene: sceneA(), dpr: 1 });
    const submits = device.submits.length;
    const stats = pipeline.render({ scene: sceneA(), dpr: 1, repaint: true });
    expect(stats.invalidation.reasons).toEqual([]);
    expect(stats.invalidation.executed).toEqual(["presentation"]);
    expect(stats.invalidation.retained).toBe(false);
    // exactly one presentation submission, no compute encoders
    expect(device.submits.length).toBe(submits + 1);
    expect(stats.frame.dispatchCount).toBe(0);
    expect(stats.frame.submissions).toBe(1);
    expect(stats.presentation.workSubmitted).toBe(2);
    expect(stats.presentation.configured).toBe(false);
  });

  it("re-runs the full chain on a geometry-only scene change", () => {
    const { device, pipeline } = setup();
    pipeline.render({ scene: sceneA(), dpr: 1 });
    const taller = sceneA();
    taller.surfaces[0].elevation += 2;
    const stats = pipeline.render({ scene: taller, dpr: 1 });
    expect(stats.invalidation.reasons).toEqual(["scene"]);
    expect(stats.invalidation.executed).toHaveLength(7);
    expect(stats.invalidation.retained).toBe(false);
    expect(stats.upload.bytesUploaded).toBeGreaterThan(0);
    expect(stats.height.composePasses).toBe(5);
    expect(device.submits.length).toBe(10);
  });

  it("propagates a normal-options change only to normal, lighting and presentation", () => {
    const { device, pipeline } = setup();
    const first = pipeline.render({ scene: sceneA(), dpr: 1 });
    const submits = device.submits.length;
    const stats = pipeline.render({
      scene: sceneA(),
      dpr: 1,
      normalOptions: { scaleX: 0.9, scaleY: 0.4, normalScale: 1.25 },
    });
    expect(stats.invalidation.reasons).toEqual(["normal-options"]);
    expect(stats.invalidation.executed).toEqual(["normal", "lighting", "presentation"]);
    expect(stats.invalidation.skipped).toEqual(["upload", "height", "shadow", "reconstruction"]);
    expect(device.submits.length).toBe(submits + 3);
    // upstream allocations are untouched (retained counts reported)
    expect(stats.upload.allocationCount).toBe(first.upload.allocationCount);
    expect(stats.height.allocationCount).toBe(first.height.allocationCount);
    expect(stats.shadow.allocationCount).toBe(first.shadow.allocationCount);
    // provenance is unchanged (height retained), so downstream mixes are legal
    const snapshot = pipeline.getSnapshot();
    expect(snapshot.normalPass.provenance).toBe(snapshot.heightPass.provenance);
    expect(snapshot.lightingPass.provenance).toBe(snapshot.heightPass.provenance);
  });

  it("propagates a shadow-options change only to shadow, lighting and presentation", () => {
    const { device, pipeline } = setup();
    pipeline.render({ scene: sceneA(), dpr: 1 });
    const submits = device.submits.length;
    const stats = pipeline.render({
      scene: sceneA(),
      dpr: 1,
      shadowOptions: { bias: 0.25, stepSize: 0.5 },
    });
    expect(stats.invalidation.reasons).toEqual(["shadow-options"]);
    expect(stats.invalidation.executed).toEqual(["shadow", "reconstruction", "lighting", "presentation"]);
    expect(stats.invalidation.skipped).toEqual(["upload", "height", "normal"]);
    // hard-shadow scene: reconstruction stays BYPASSED (3 dispatching stages)
    expect(device.submits.length).toBe(submits + 3);
  });

  it("propagates a lighting-options (ambient) change only to lighting and presentation", () => {
    const { device, pipeline } = setup();
    pipeline.render({ scene: sceneA(), dpr: 1 });
    const submits = device.submits.length;
    const stats = pipeline.render({ scene: sceneA(), dpr: 1, lightingOptions: { ambient: 0.3 } });
    expect(stats.invalidation.reasons).toEqual(["lighting-options"]);
    expect(stats.invalidation.executed).toEqual(["lighting", "presentation"]);
    expect(stats.invalidation.skipped).toEqual(["upload", "height", "normal", "shadow", "reconstruction"]);
    expect(device.submits.length).toBe(submits + 2);
    // the effective ambient is the f32-packed value actually dispatched
    expect(pipeline.getSnapshot().lightingPass.ambient).toBeCloseTo(0.3, 6);
  });

  it("propagates a composite-options change to presentation only", () => {
    const { device, pipeline } = setup();
    pipeline.render({ scene: sceneA(), dpr: 1 });
    const submits = device.submits.length;
    const stats = pipeline.render({
      scene: sceneA(),
      dpr: 1,
      compositeOptions: { shadowAlpha: 0.6 },
    });
    expect(stats.invalidation.reasons).toEqual(["composite-options"]);
    expect(stats.invalidation.executed).toEqual(["presentation"]);
    expect(stats.invalidation.skipped).toEqual(["upload", "height", "normal", "shadow", "reconstruction", "lighting"]);
    expect(device.submits.length).toBe(submits + 1);
  });

  it("re-runs the full chain on a DPR (viewport) change and resizes the canvas", () => {
    const { context, device, pipeline } = setup();
    pipeline.render({ scene: sceneA(), dpr: 1 });
    const stats = pipeline.render({ scene: sceneA(), dpr: 2 });
    expect(stats.invalidation.reasons).toContain("viewport");
    expect(stats.invalidation.executed).toHaveLength(7);
    expect(stats.renderWidth).toBe(200);
    expect(stats.renderHeight).toBe(160);
    expect(context.canvas.width).toBe(200);
    expect(context.canvas.height).toBe(160);
    // the presentation configuration is reused across sizes (retained)
    expect(context.configured).toHaveLength(1);
  });

  it("a forced full recompute re-uploads byte-identical payloads and reuses allocations", () => {
    const { device, pipeline } = setup();
    pipeline.render({ scene: sceneA(), dpr: 1 });
    const frame1Writes = writePayloads(device);
    const frame1Provenance = pipeline.getSnapshot().heightPass.provenance;
    pipeline.render({ scene: sceneA(), dpr: 1 }); // fully retained
    pipeline.render({ scene: sceneB(), dpr: 1 }); // different scene
    const writesBeforeReplay = device.writes.length;
    const replayed = pipeline.render({ scene: sceneA(), dpr: 1 }); // forced full recompute
    // sceneB differs in extent and shadow-context-dependent effective
    // options, so the replay legitimately reports all three reasons
    expect(replayed.invalidation.reasons).toContain("scene");
    expect(replayed.invalidation.reasons).toContain("viewport");
    expect(replayed.invalidation.executed).toHaveLength(7);
    // the replayed upload bytes are byte-identical to frame 1 (deterministic
    // encode) — the forced recompute produces the same effective payloads
    const replayWrites = device.writes.slice(writesBeforeReplay).map((w) => Array.from(w.bytes));
    expect(replayWrites).toEqual(frame1Writes);
    // a fresh height dispatch produced a fresh per-dispatch provenance token
    // (equivalent to a forced full recompute) while the pass allocations are
    // reused (no new GPU buffers)
    const snapshot = pipeline.getSnapshot();
    expect(snapshot.heightPass.provenance).not.toBe(frame1Provenance);
    expect(snapshot.heightPass.provenance.sceneBytes.byteLength).toBeGreaterThan(0);
    expect(replayed.frame.newAllocations).toBe(0);
    expect(replayed.totals.frames).toBe(4);
  });

  it("invalidates scheduler retention when a stage fails mid-frame and the next render fully recomputes", () => {
    const { device, pipeline } = setup();
    pipeline.render({ scene: sceneA(), dpr: 1 });
    // Inject a failure in the NEXT frame AFTER the changed-scene upload has
    // already mutated the uploader bindings: the height pass is the first
    // stage that creates a command encoder.
    device.failNextEncoder = true;
    expect(() => pipeline.render({ scene: sceneB(), dpr: 1 })).toThrow(/injected encoder failure/);
    // conservative invalidation: no usable stale snapshot or re-presentation
    expect(() => pipeline.getSnapshot()).toThrow(/no frame rendered/);
    expect(() => pipeline.present()).toThrow(/no frame rendered/);
    // the same changed scene now fully recomputes and succeeds (first-frame
    // path: no retained key/encoding to skip or mix)
    const recovered = pipeline.render({ scene: sceneB(), dpr: 1 });
    expect(recovered.invalidation.reasons).toEqual(["first-frame"]);
    expect(recovered.invalidation.executed).toHaveLength(7);
    expect(recovered.upload.bytesUploaded).toBeGreaterThan(0);
    expect(recovered.height.composePasses).toBe(5);
    const snapshot = pipeline.getSnapshot();
    // every downstream stage shares the fresh per-dispatch provenance
    expect(snapshot.normalPass.provenance).toBe(snapshot.heightPass.provenance);
    expect(snapshot.shadowPass.provenance).toBe(snapshot.heightPass.provenance);
    expect(snapshot.lightingPass.provenance).toBe(snapshot.heightPass.provenance);
    // the pre-failure scene ALSO recovers: re-uploading sceneA must not
    // skip the upload (no mixed provenance from the failed frame)
    const replayA = pipeline.render({ scene: sceneA(), dpr: 1 });
    expect(replayA.invalidation.executed).toHaveLength(7);
    expect(replayA.upload.bytesUploaded).toBeGreaterThan(0);
    expect(replayA.height.composePasses).toBe(5);
    expect(pipeline.getSnapshot().heightPass.provenance).not.toBe(snapshot.heightPass.provenance);
  });

  it("recovers through a fresh pipeline after disposal (context recovery seam)", () => {
    const first = setup();
    first.pipeline.render({ scene: sceneA(), dpr: 1 });
    first.pipeline.dispose();
    expect(first.context.unconfigured).toBe(true);
    // the recovery seam: a fresh device/context/pipeline starts clean and
    // never touches the disposed pipeline's resources
    const second = setup();
    const stats = second.pipeline.render({ scene: sceneA(), dpr: 1 });
    expect(stats.invalidation.reasons).toEqual(["first-frame"]);
    expect(second.context.configured).toHaveLength(1);
    expect(second.context.unconfigured).toBe(false);
    // the first pipeline's device allocations were all destroyed
    expect(first.device.created.every((buffer) => buffer.destroyed)).toBe(true);
  });

  it("recovers with a fresh pipeline after device loss", async () => {
    const first = setup();
    first.pipeline.render({ scene: sceneA(), dpr: 1 });
    first.device.triggerLoss();
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 0));
    expect(() => first.pipeline.render({ scene: sceneA(), dpr: 1 })).toThrow(/device is lost/);
    first.pipeline.dispose(); // idempotent even after loss
    first.pipeline.dispose();
    const second = setup();
    const stats = second.pipeline.render({ scene: sceneA(), dpr: 1 });
    expect(stats.invalidation.retained).toBe(false);
    expect(second.device.submits).toHaveLength(5);
  });
});

describe("GpuScenePipeline — semantic scene invalidation (light/env/material)", () => {
  /** sceneA with a different light direction (geometry identical). */
  const withLight = (direction: { x: number; y: number; z: number }, intensity = 1): Scene => {
    const base = sceneA();
    return createScene({
      width: base.width,
      height: base.height,
      surfaces: base.surfaces.map((surface) => ({ ...surface })),
      light: { direction, intensity },
    });
  };
  const withEnvironment = (): Scene => {
    const base = sceneA();
    return createScene({
      width: base.width,
      height: base.height,
      surfaces: base.surfaces.map((surface) => ({ ...surface })),
      light: { direction: base.light.direction, intensity: base.light.intensity },
      environment: { intensity: 0.9, diffuseIntensity: 0.8, specularIntensity: 0.7 },
      exposure: 1.25,
    });
  };
  const withMaterials = (): Scene => {
    const base = sceneA();
    return createScene({
      width: base.width,
      height: base.height,
      surfaces: base.surfaces.map((surface) => ({ ...surface })),
      light: { direction: base.light.direction, intensity: base.light.intensity },
      materials: {
        silicone: { baseColor: { r: 0.9, g: 0.85, b: 0.8 }, roughness: 0.4, metallic: 0, ior: 1.45 },
      },
    });
  };
  const taller = (): Scene => {
    const base = sceneA();
    base.surfaces[0].elevation += 2;
    return base;
  };

  it("skips height and normal on a light-direction change", () => {
    const { device, pipeline } = setup();
    const first = pipeline.render({ scene: sceneA(), dpr: 1 });
    const firstProvenance = pipeline.getSnapshot().heightPass.provenance;
    const submits = device.submits.length; // 5
    const stats = pipeline.render({
      scene: withLight({ x: 0, y: 0, z: 1 }),
      dpr: 1,
    });
    expect(stats.invalidation.reasons).toEqual(["light-direction"]);
    expect(stats.invalidation.executed).toEqual(["upload", "shadow", "reconstruction", "lighting", "presentation"]);
    expect(stats.invalidation.skipped).toEqual(["height", "normal"]);
    // exactly four stages submitted: no height/normal work
    expect(device.submits.length).toBe(submits + 3);
    expect(stats.upload.bytesUploaded).toBeGreaterThan(0);
    // the retained height/normal fields keep their provenance and buffers
    const snapshot = pipeline.getSnapshot();
    expect(snapshot.heightPass.provenance).toBe(firstProvenance);
    expect(snapshot.normalPass.provenance).toBe(firstProvenance);
    expect(snapshot.shadowPass.provenance).toBe(firstProvenance);
    expect(snapshot.lightingPass.provenance).toBe(firstProvenance);
    // the planning report never plans a partial for a retained height frame
    expect(stats.planning.mode).toBe("full");
    expect(stats.planning.reason).toBe("light-direction-change");
    expect(first.upload.allocationCount).toBe(stats.upload.allocationCount);
    expect(first.height.allocationCount).toBe(stats.height.allocationCount);
  });

  it("skips height, normal and shadow on light-intensity/environment/material changes", () => {
    for (const [label, scene] of [
      ["light-intensity", withLight({ x: -0.70710678, y: 0, z: 0.70710678 }, 2)],
      ["environment", withEnvironment()],
      ["material-values", withMaterials()],
    ] as const) {
      const { device, pipeline } = setup();
      pipeline.render({ scene: sceneA(), dpr: 1 });
      const submits = device.submits.length;
      const stats = pipeline.render({ scene, dpr: 1 });
      expect(stats.invalidation.reasons).toEqual([label]);
      expect(stats.invalidation.executed).toEqual(["upload", "lighting", "presentation"]);
      expect(stats.invalidation.skipped).toEqual(["height", "normal", "shadow", "reconstruction"]);
      expect(device.submits.length).toBe(submits + 2);
      expect(stats.planning.mode).toBe("full");
      expect(stats.planning.reason).toBe(`${label}-change`);
    }
  });

  it("keeps retained fields consistent across repeated light changes", () => {
    const { pipeline } = setup();
    pipeline.render({ scene: sceneA(), dpr: 1 });
    const provenance = pipeline.getSnapshot().heightPass.provenance;
    for (const direction of [
      { x: 0, y: 0, z: 1 },
      { x: -0.70710678, y: 0, z: 0.70710678 },
      { x: 1, y: 0, z: 0 },
    ]) {
      pipeline.render({ scene: withLight(direction), dpr: 1 });
      const snapshot = pipeline.getSnapshot();
      expect(snapshot.heightPass.provenance).toBe(provenance);
      expect(snapshot.normalPass.provenance).toBe(provenance);
      expect(snapshot.shadowPass.provenance).toBe(provenance);
      expect(snapshot.lightingPass.provenance).toBe(provenance);
    }
  });

  it("a geometry change after retained light-only frames re-runs the full chain with a fresh provenance", () => {
    const { device, pipeline } = setup();
    pipeline.render({ scene: sceneA(), dpr: 1 });
    const firstProvenance = pipeline.getSnapshot().heightPass.provenance;
    expect(firstProvenance.heightInputs).toBeDefined();
    pipeline.render({ scene: withLight({ x: 0, y: 0, z: 1 }), dpr: 1 });
    const submits = device.submits.length;
    const stats = pipeline.render({ scene: taller(), dpr: 1 });
    expect(stats.invalidation.reasons).toEqual(["scene"]);
    expect(stats.invalidation.executed).toHaveLength(7);
    expect(device.submits.length).toBe(submits + 5);
    const snapshot = pipeline.getSnapshot();
    expect(snapshot.heightPass.provenance).not.toBe(firstProvenance);
    expect(snapshot.normalPass.provenance).toBe(snapshot.heightPass.provenance);
    expect(snapshot.shadowPass.provenance).toBe(snapshot.heightPass.provenance);
    expect(snapshot.lightingPass.provenance).toBe(snapshot.heightPass.provenance);
  });

  it("unions light-direction and light-intensity changes into one closure", () => {
    const { device, pipeline } = setup();
    pipeline.render({ scene: sceneA(), dpr: 1 });
    const submits = device.submits.length;
    const stats = pipeline.render({ scene: withLight({ x: 0, y: 0, z: 1 }, 2), dpr: 1 });
    expect(stats.invalidation.reasons).toEqual(["light-direction", "light-intensity"]);
    expect(stats.invalidation.executed).toEqual(["upload", "shadow", "reconstruction", "lighting", "presentation"]);
    expect(device.submits.length).toBe(submits + 3);
  });
});

describe("WebGpuBackend — capabilities.compute stays false until #30", () => {
  it("still reports compute: false (no public GPU selection before parity)", async () => {
    const { WebGpuBackend } = await import("../backend/webgpu");
    const backend = new WebGpuBackend({ destroy() {} } as never);
    expect(backend.capabilities.backend).toBe("webgpu");
    expect(backend.capabilities.compute).toBe(false);
    backend.dispose();
  });
});

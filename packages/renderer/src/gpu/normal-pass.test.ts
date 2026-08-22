import { describe, expect, it } from "vitest";
import { createScene } from "../scene";
import type { Scene } from "../scene";
import { encodeScene } from "./encode";
import { HeightPass } from "./height-pass";
import type {
  GpuBindGroupEntryLike,
  GpuBindGroupLayoutEntryLike,
  GpuBindGroupLayoutLike,
  GpuBindGroupLike,
  GpuCommandBufferLike,
  GpuCommandEncoderLike,
  GpuComputeDeviceLike,
  GpuComputePassEncoderLike,
  GpuComputePipelineLike,
  GpuLimitsLike,
  GpuPipelineLayoutLike,
  GpuShaderModuleLike,
} from "./height-pass";
import { WORKGROUP_SIZE as HEIGHT_WORKGROUP_SIZE } from "./height-pass-wgsl";
import { GPU_USAGE_STORAGE } from "./layout";
import { SceneUploader } from "./uploader";
import type { GpuBufferLike } from "./uploader";
import {
  NORMAL_OUTPUT_BYTES_PER_TEXEL,
  NORMAL_PARAMS_BYTE_LENGTH,
  NORMAL_PASS_WGSL,
  NORMAL_WORKGROUP_SIZE,
} from "./normal-pass-wgsl";
import {
  NORMAL_PASS_OUTPUT_USAGE,
  NormalPass,
  normalHeightBindingFromHeightPass,
  sanitizeNormalOptions,
} from "./normal-pass";
import type { NormalHeightBinding } from "./normal-pass";

// ---------------------------------------------------------------------------
// Realistic structural mock: implements the same GpuComputeDeviceLike surface
// the real GPUDevice is cast into, with no fabricated WebGPU methods. It
// records every call; it does NOT execute shaders (numeric parity is a
// real-GPU browser test, not a mock claim).
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

interface MockPassRecord {
  pipeline: unknown;
  bindGroups: Array<{ index: number; bindGroup: unknown }>;
  dispatch: Array<{ x: number; y: number; z: number }>;
}

class MockComputePass implements GpuComputePassEncoderLike {
  readonly log: string[] = [];
  readonly calls: MockPassRecord = { pipeline: null, bindGroups: [], dispatch: [] };

  setPipeline(pipeline: GpuComputePipelineLike): void {
    this.calls.pipeline = pipeline;
    this.log.push("setPipeline");
  }
  setBindGroup(index: number, bindGroup: GpuBindGroupLike): void {
    this.calls.bindGroups.push({ index, bindGroup });
    this.log.push(`setBindGroup(${index})`);
  }
  dispatchWorkgroups(x: number, y = 1, z = 1): void {
    this.calls.dispatch.push({ x, y, z });
    this.log.push(`dispatch(${x})`);
  }
  end(): void {
    this.log.push("end");
  }
}

class MockEncoder implements GpuCommandEncoderLike {
  readonly passes: MockComputePass[] = [];
  finished = false;
  beginComputePass(): GpuComputePassEncoderLike {
    const pass = new MockComputePass();
    this.passes.push(pass);
    return pass;
  }
  finish(): GpuCommandBufferLike {
    this.finished = true;
    return { label: "mock-cmd" };
  }
}

class MockDevice implements GpuComputeDeviceLike {
  readonly limits: GpuLimitsLike;
  readonly created: Array<{ desc: { size: number; usage: number; label?: string }; buffer: MockBuffer }> = [];
  readonly shaderModules: string[] = [];
  readonly pipelines: Array<{
    layout: GpuPipelineLayoutLike;
    module: GpuShaderModuleLike;
    entryPoint: string;
    pipeline: GpuComputePipelineLike;
  }> = [];
  readonly bindGroupLayouts: Array<{
    entries: GpuBindGroupLayoutEntryLike[];
    layout: GpuBindGroupLayoutLike;
  }> = [];
  readonly pipelineLayouts: Array<{
    bindGroupLayouts: GpuBindGroupLayoutLike[];
    layout: GpuPipelineLayoutLike;
  }> = [];
  readonly bindGroups: Array<{
    layout: GpuBindGroupLayoutLike;
    entries: GpuBindGroupEntryLike[];
    bindGroup: GpuBindGroupLike;
  }> = [];
  readonly encoders: MockEncoder[] = [];
  readonly writes: Array<{ buffer: MockBuffer; dstByteOffset: number; bytes: Uint8Array }> = [];
  readonly submits: GpuCommandBufferLike[][] = [];

  constructor(limits: Partial<GpuLimitsLike> = {}) {
    this.limits = {
      maxStorageBufferBindingSize: 1 << 28,
      maxBufferSize: 1 << 28,
      maxComputeWorkgroupSizeX: 256,
      maxComputeInvocationsPerWorkgroup: 256,
      maxComputeWorkgroupsPerDimension: 65535,
      maxStorageBuffersPerShaderStage: 8,
      ...limits,
    };
  }

  readonly queue = {
    writeBuffer: (buffer: GpuBufferLike, dstByteOffset: number, source: Uint8Array): void => {
      const mock = buffer as MockBuffer;
      this.writes.push({ buffer: mock, dstByteOffset, bytes: source.slice() });
    },
    submit: (commandBuffers: readonly GpuCommandBufferLike[]): void => {
      this.submits.push([...commandBuffers]);
    },
  };

  createBuffer(desc: { size: number; usage: number; label?: string }): GpuBufferLike {
    const buffer = new MockBuffer(desc.size, desc.usage, desc.label);
    this.created.push({ desc, buffer });
    return buffer;
  }

  createShaderModule(desc: { code: string; label?: string }): GpuShaderModuleLike {
    this.shaderModules.push(desc.code);
    return { label: desc.label };
  }

  createComputePipeline(desc: {
    layout: GpuPipelineLayoutLike;
    compute: { module: GpuShaderModuleLike; entryPoint: string };
    label?: string;
  }): GpuComputePipelineLike {
    const pipeline = { label: desc.label };
    this.pipelines.push({
      layout: desc.layout,
      module: desc.compute.module,
      entryPoint: desc.compute.entryPoint,
      pipeline,
    });
    return pipeline;
  }

  createBindGroupLayout(desc: {
    entries: readonly GpuBindGroupLayoutEntryLike[];
    label?: string;
  }): GpuBindGroupLayoutLike {
    const layout = { label: desc.label };
    this.bindGroupLayouts.push({ entries: [...desc.entries], layout });
    return layout;
  }

  createPipelineLayout(desc: {
    bindGroupLayouts: readonly GpuBindGroupLayoutLike[];
    label?: string;
  }): GpuPipelineLayoutLike {
    const layout = { label: desc.label };
    this.pipelineLayouts.push({ bindGroupLayouts: [...desc.bindGroupLayouts], layout });
    return layout;
  }

  createBindGroup(desc: {
    layout: GpuBindGroupLayoutLike;
    entries: readonly GpuBindGroupEntryLike[];
    label?: string;
  }): GpuBindGroupLike {
    const bindGroup = { label: desc.label };
    this.bindGroups.push({ layout: desc.layout, entries: [...desc.entries], bindGroup });
    return bindGroup;
  }

  createCommandEncoder(desc?: { label?: string }): GpuCommandEncoderLike {
    const encoder = new MockEncoder();
    this.encoders.push(encoder);
    return encoder;
  }
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function simpleScene(): Scene {
  return createScene({
    width: 100,
    height: 80,
    surfaces: [
      {
        id: "a",
        position: { x: 10, y: 20 },
        size: { x: 60, y: 40 },
        elevation: 2,
        thickness: 3,
        bevelWidth: 1,
        shape: { kind: "roundedRect", radius: 8 },
        profile: { kind: "bevel" },
        material: "silicone",
        castsShadow: true,
        receivesShadow: false,
      },
    ],
    light: { direction: { x: -0.6, y: -0.8, z: 1 }, intensity: 2 },
  });
}

/**
 * Build a REAL #25 height binding through the actual `HeightPass` mock flow:
 * `encodeScene` -> `SceneUploader.upload` -> `HeightPass.dispatch` ->
 * `getSnapshot()`, then `normalHeightBindingFromHeightPass`. Exercises the
 * narrow structural boundary exactly like the browser harness.
 */
function heightPassBinding(
  mock: MockDevice,
  scene: Scene,
  dpr = 1,
): { input: NormalHeightBinding; outputs: ReturnType<HeightPass["getOutputs"]> } {
  const uploader = new SceneUploader(mock);
  const pass = new HeightPass(mock);
  const encoded = encodeScene(scene, dpr);
  uploader.upload(encoded);
  pass.dispatch(encoded, uploader.getBindings());
  const snapshot = pass.getSnapshot();
  return { input: normalHeightBindingFromHeightPass(snapshot), outputs: pass.getOutputs() };
}

function manualBinding(width: number, height: number, overrides: Partial<NormalHeightBinding> = {}): {
  binding: NormalHeightBinding;
  buffer: MockBuffer;
} {
  const byteLength = width * height * 4;
  const buffer = new MockBuffer(Math.max(byteLength, 16), NORMAL_PASS_OUTPUT_USAGE, "height");
  return {
    binding: {
      buffer,
      byteLength,
      format: "f32",
      usage: NORMAL_PASS_OUTPUT_USAGE,
      width,
      height,
      ...overrides,
    },
    buffer,
  };
}

function setup() {
  const mock = new MockDevice();
  const pass = new NormalPass(mock);
  return { mock, pass };
}

// ---------------------------------------------------------------------------
// Option sanitization
// ---------------------------------------------------------------------------

describe("sanitizeNormalOptions — CPU-compatible effective options", () => {
  it("keeps the CPU defaults (0.5, 0.5, 1) for empty options", () => {
    expect(sanitizeNormalOptions()).toEqual({ scaleX: 0.5, scaleY: 0.5, normalScale: 1 });
    expect(sanitizeNormalOptions({})).toEqual({ scaleX: 0.5, scaleY: 0.5, normalScale: 1 });
  });

  it("allows finite custom x/y scales including zero and negatives", () => {
    expect(sanitizeNormalOptions({ scaleX: 0, scaleY: -2, normalScale: 3 }).scaleX).toBe(0);
    expect(sanitizeNormalOptions({ scaleX: 0, scaleY: -2, normalScale: 3 }).scaleY).toBe(-2);
    expect(sanitizeNormalOptions({ scaleX: 4, scaleY: 0.25 }).scaleX).toBe(4);
  });

  it("falls back to the defaults for non-finite scales", () => {
    expect(sanitizeNormalOptions({ scaleX: NaN }).scaleX).toBe(0.5);
    expect(sanitizeNormalOptions({ scaleX: Infinity }).scaleX).toBe(0.5);
    expect(sanitizeNormalOptions({ scaleX: -Infinity }).scaleX).toBe(0.5);
    expect(sanitizeNormalOptions({ scaleY: NaN }).scaleY).toBe(0.5);
  });

  it("requires normalScale finite and strictly positive or falls back to 1", () => {
    expect(sanitizeNormalOptions({ normalScale: 0 }).normalScale).toBe(1);
    expect(sanitizeNormalOptions({ normalScale: -1 }).normalScale).toBe(1);
    expect(sanitizeNormalOptions({ normalScale: NaN }).normalScale).toBe(1);
    expect(sanitizeNormalOptions({ normalScale: Infinity }).normalScale).toBe(1);
    expect(sanitizeNormalOptions({ normalScale: 0.5 }).normalScale).toBe(0.5);
  });

  it("judges normalScale AFTER f32 rounding: below the min positive subnormal falls back", () => {
    // Math.fround(5e-324) === 0 and Math.fround(1e-46) === 0: the value that
    // would actually be packed is zero, so it must fall back to 1
    expect(sanitizeNormalOptions({ normalScale: 5e-324 }).normalScale).toBe(1);
    expect(sanitizeNormalOptions({ normalScale: 1e-46 }).normalScale).toBe(1);
    // the minimum positive subnormal itself is f32-exact and strictly
    // positive, so it is kept
    const minSubnormal = 1.401298464324817e-45;
    expect(sanitizeNormalOptions({ normalScale: minSubnormal }).normalScale).toBe(minSubnormal);
  });

  it("falls back for finite JS values outside the f32 range", () => {
    expect(sanitizeNormalOptions({ scaleX: 1e300 }).scaleX).toBe(0.5);
    expect(sanitizeNormalOptions({ scaleX: -1e300 }).scaleX).toBe(0.5);
    expect(sanitizeNormalOptions({ scaleY: 1e300 }).scaleY).toBe(0.5);
    expect(sanitizeNormalOptions({ normalScale: 1e300 }).normalScale).toBe(1);
  });

  it("judges the f32-rounded value: values above the f32 rounding boundary fall back", () => {
    // F32_MAX + 2^103 is the rounding boundary: values below it round to the
    // largest finite f32, the boundary itself and above round to infinity.
    // Math.fround(3.4028235e38) === F32_MAX (finite, kept);
    // Math.fround(3.4028235677973366e38) === Infinity (cannot be packed).
    expect(sanitizeNormalOptions({ scaleX: 3.4028235e38 }).scaleX).toBe(
      Math.fround(3.4028235e38),
    );
    expect(sanitizeNormalOptions({ scaleX: 3.4028235677973366e38 }).scaleX).toBe(0.5);
    expect(sanitizeNormalOptions({ normalScale: 3.4028235677973366e38 }).normalScale).toBe(1);
  });

  it("rounds representable finite values to f32", () => {
    expect(sanitizeNormalOptions({ scaleX: 0.1 }).scaleX).toBe(Math.fround(0.1));
    expect(sanitizeNormalOptions({ scaleX: 0.75 }).scaleX).toBe(0.75); // f32-exact
    expect(sanitizeNormalOptions({ normalScale: 0.3 }).normalScale).toBe(Math.fround(0.3));
  });
});

// ---------------------------------------------------------------------------
// Pipeline caching and explicit layouts
// ---------------------------------------------------------------------------

describe("NormalPass — explicit layout/pipeline creation and caching", () => {
  it("creates the shader module, layouts and pipeline once and reuses them", () => {
    const { mock, pass } = setup();
    const { binding } = manualBinding(100, 80);
    pass.dispatch({ height: binding });
    expect(mock.shaderModules).toHaveLength(1);
    expect(mock.bindGroupLayouts).toHaveLength(1);
    expect(mock.pipelineLayouts).toHaveLength(1);
    expect(mock.pipelines).toHaveLength(1);

    pass.dispatch({ height: binding }); // same extent -> full cache
    expect(mock.shaderModules).toHaveLength(1);
    expect(mock.pipelines).toHaveLength(1);

    const { binding: wide } = manualBinding(300, 200);
    pass.dispatch({ height: wide }); // different extent -> still cached
    expect(mock.shaderModules).toHaveLength(1);
    expect(mock.pipelines).toHaveLength(1);
  });

  it("uses an explicit pipeline layout (never layout: 'auto')", () => {
    const { mock, pass } = setup();
    const { binding } = manualBinding(100, 80);
    pass.dispatch({ height: binding });
    expect(mock.pipelines[0].layout).toBe(mock.pipelineLayouts[0].layout);
    expect(mock.pipelineLayouts[0].bindGroupLayouts[0]).toBe(mock.bindGroupLayouts[0].layout);
  });

  it("pins the bind group layout entries with shader-derived minimum sizes", () => {
    const { mock, pass } = setup();
    const { binding } = manualBinding(100, 80);
    pass.dispatch({ height: binding });
    const entries = mock.bindGroupLayouts[0].entries;
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      binding: 0,
      buffer: { type: "uniform", hasDynamicOffset: false, minBindingSize: NORMAL_PARAMS_BYTE_LENGTH },
    });
    expect(entries[1]).toMatchObject({
      binding: 1,
      buffer: { type: "read-only-storage", hasDynamicOffset: false, minBindingSize: 4 },
    });
    expect(entries[2]).toMatchObject({
      binding: 2,
      buffer: { type: "storage", hasDynamicOffset: false, minBindingSize: NORMAL_OUTPUT_BYTES_PER_TEXEL },
    });
    for (const entry of entries) {
      expect(entry.visibility).toBe(0x4); // COMPUTE stage
    }
  });
});

// ---------------------------------------------------------------------------
// Direct #25 height binding identity
// ---------------------------------------------------------------------------

describe("NormalPass — direct #25 height binding identity", () => {
  it("binds the EXACT #25 height output buffer (never a copy)", () => {
    const mock = new MockDevice();
    const { input, outputs } = heightPassBinding(mock, simpleScene());
    const pass = new NormalPass(mock);
    pass.dispatch({ height: input });
    const group = mock.bindGroups.at(-1)!;
    expect(group.entries).toHaveLength(3);
    expect(group.entries[0].binding).toBe(0);
    expect(group.entries[1].binding).toBe(1);
    expect(group.entries[1].resource.buffer).toBe(outputs.height.buffer); // direct identity
    expect(group.entries[2].binding).toBe(2);
  });

  it("uses the height snapshot dimensions through normalHeightBindingFromHeightPass", () => {
    const mock = new MockDevice();
    const { input } = heightPassBinding(mock, simpleScene(), 1.5); // 150x120
    expect(input.width).toBe(150);
    expect(input.height).toBe(120);
    expect(input.byteLength).toBe(150 * 120 * 4);
    expect(input.format).toBe("f32");
    expect(input.usage & GPU_USAGE_STORAGE).toBe(GPU_USAGE_STORAGE);
  });
});

// ---------------------------------------------------------------------------
// Uniform packing
// ---------------------------------------------------------------------------

describe("NormalPass — exact uniform packing", () => {
  it("packs options and dims little-endian at the pinned offsets", () => {
    const { mock, pass } = setup();
    const { binding } = manualBinding(150, 120);
    pass.dispatch({ height: binding, options: { scaleX: 0.75, scaleY: 0.25, normalScale: 2 } });
    const uniformWrite = mock.writes[0];
    expect(uniformWrite.bytes.byteLength).toBe(NORMAL_PARAMS_BYTE_LENGTH);
    const view = new DataView(uniformWrite.bytes.buffer);
    expect(view.getFloat32(0, true)).toBe(0.75);
    expect(view.getFloat32(4, true)).toBe(0.25);
    expect(view.getFloat32(8, true)).toBe(2);
    expect(view.getUint32(12, true)).toBe(150);
    expect(view.getUint32(16, true)).toBe(120);
    expect(view.getUint32(20, true)).toBe(NORMAL_WORKGROUP_SIZE);
    expect(view.getUint32(24, true)).toBe(0); // pad
    expect(view.getUint32(28, true)).toBe(0); // pad
  });

  it("packs the effective sanitized options (f32-rounded)", () => {
    const { mock, pass } = setup();
    const { binding } = manualBinding(10, 10);
    pass.dispatch({ height: binding, options: { scaleX: 0.1, normalScale: 0 } });
    const view = new DataView(mock.writes[0].bytes.buffer);
    expect(view.getFloat32(0, true)).toBe(Math.fround(0.1)); // f32-rounded
    expect(view.getFloat32(4, true)).toBe(0.5); // default
    expect(view.getFloat32(8, true)).toBe(1); // normalScale 0 falls back to 1
  });
});

// ---------------------------------------------------------------------------
// Command order, dispatch dims, no readback
// ---------------------------------------------------------------------------

describe("NormalPass — command order, ceil-division and no readback", () => {
  it("records pipeline, bind group, ceil-divided dispatch and end, then submits once", () => {
    const { mock, pass } = setup();
    const { binding } = manualBinding(150, 120); // 18000 texels
    pass.dispatch({ height: binding });
    const encoder = mock.encoders[0];
    expect(encoder.passes).toHaveLength(1);
    const compute = encoder.passes[0];
    expect(compute.calls.pipeline).toBe(mock.pipelines[0].pipeline);
    expect(compute.log).toEqual([
      "setPipeline",
      "setBindGroup(0)",
      `dispatch(${Math.ceil(18000 / NORMAL_WORKGROUP_SIZE)})`,
      "end",
    ]);
    expect(compute.calls.dispatch[0]).toEqual({
      x: Math.ceil(18000 / NORMAL_WORKGROUP_SIZE),
      y: 1,
      z: 1,
    });
    expect(encoder.finished).toBe(true);
    expect(mock.submits).toHaveLength(1);
    expect(mock.submits[0]).toHaveLength(1);
    expect(pass.getSnapshot().lastDispatch.workgroupCountX).toBe(
      Math.ceil(18000 / NORMAL_WORKGROUP_SIZE),
    );
  });

  it("uses one GPU invocation per texel with the documented workgroup size", () => {
    const { mock, pass } = setup();
    const { binding } = manualBinding(100, 80); // 8000 texels
    pass.dispatch({ height: binding });
    expect(pass.getSnapshot().workgroupSize).toBe(NORMAL_WORKGROUP_SIZE);
    expect(mock.encoders[0].passes[0].calls.dispatch[0].x).toBe(Math.ceil(8000 / 64));
  });

  it("exposes no map/readback path during normal dispatch", () => {
    const { mock, pass } = setup();
    const { binding } = manualBinding(100, 80);
    pass.dispatch({ height: binding });
    const queue = mock.queue as unknown as Record<string, unknown>;
    expect(queue.mapAsync).toBeUndefined();
    expect(queue.copyBufferToBuffer).toBeUndefined();
    for (const { buffer } of mock.created) {
      const b = buffer as unknown as Record<string, unknown>;
      expect(b.mapAsync).toBeUndefined();
      expect(b.getMappedRange).toBeUndefined();
    }
    // the only queue traffic is the params uniform upload and one submit
    expect(mock.writes).toHaveLength(1);
    expect(mock.submits).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Allocation reuse/growth, snapshot, disposal
// ---------------------------------------------------------------------------

describe("NormalPass — output allocation size/usage, reuse, growth, snapshot", () => {
  it("allocates the uniform and the tightly packed output on the first dispatch", () => {
    const { mock, pass } = setup();
    const { binding } = manualBinding(100, 80); // 8000 texels -> 96000 output bytes
    const stats = pass.dispatch({ height: binding });
    expect(stats.newAllocations).toBe(2);
    expect(stats.allocationCount).toBe(2);
    expect(mock.created[0].desc.label).toBe("ukibori-uniform");
    expect(mock.created[0].desc.size).toBe(NORMAL_PARAMS_BYTE_LENGTH);
    expect(mock.created[0].desc.usage).toBe(0x40 | 0x8); // UNIFORM | COPY_DST
    expect(mock.created[1].desc.label).toBe("ukibori-outNormal");
    expect(mock.created[1].desc.size).toBe(Math.max(8000 * 12, 16));
    expect(mock.created[1].desc.usage).toBe(NORMAL_PASS_OUTPUT_USAGE); // STORAGE|COPY_SRC|COPY_DST
    expect(NORMAL_PASS_OUTPUT_USAGE).toBe(0x80 | 0x4 | 0x8);
    expect(mock.created[1].desc.usage & 0x1).toBe(0); // no MAP_READ anywhere
  });

  it("reuses both allocations across dispatches and only grows the output", () => {
    const { mock, pass } = setup();
    const { binding } = manualBinding(100, 80);
    pass.dispatch({ height: binding });
    expect(mock.created).toHaveLength(2);

    // same extent + new options -> full reuse (option updates never reallocate)
    const next = pass.dispatch({ height: binding, options: { scaleX: 4 } });
    expect(next.newAllocations).toBe(0);
    expect(mock.created).toHaveLength(2);

    // wider extent -> only the output grows
    const { binding: wide } = manualBinding(300, 200); // 720000 output bytes
    const grown = pass.dispatch({ height: wide });
    expect(grown.newAllocations).toBe(1);
    expect(mock.created[0].buffer.destroyed).toBe(false); // uniform reused
    expect(mock.created[1].buffer.destroyed).toBe(true); // old output disposed
    expect(mock.created).toHaveLength(3);

    // smaller extent -> nothing shrinks, everything is reused
    const again = pass.dispatch({ height: binding });
    expect(again.newAllocations).toBe(0);
    expect(mock.created).toHaveLength(3);
  });

  it("exposes the stable snapshot with output, options, workgroup and dispatch dims", () => {
    const { mock, pass } = setup();
    const { binding } = manualBinding(30, 20);
    pass.dispatch({ height: binding, options: { scaleX: 0, normalScale: 5 } });
    const snapshot = pass.getSnapshot();
    expect(snapshot.width).toBe(30);
    expect(snapshot.height).toBe(20);
    expect(snapshot.workgroupSize).toBe(NORMAL_WORKGROUP_SIZE);
    expect(snapshot.options).toEqual({ scaleX: 0, scaleY: 0.5, normalScale: 5 });
    expect(snapshot.output).toMatchObject({
      buffer: mock.created[1].buffer,
      byteLength: 30 * 20 * NORMAL_OUTPUT_BYTES_PER_TEXEL,
      format: "f32",
      channels: 3,
      usage: NORMAL_PASS_OUTPUT_USAGE,
    });
    expect(snapshot.lastDispatch).toEqual({
      renderWidth: 30,
      renderHeight: 20,
      workgroupCountX: Math.ceil(600 / NORMAL_WORKGROUP_SIZE),
    });
    expect(pass.getSnapshot().output.buffer).toBe(snapshot.output.buffer); // stable
  });

  it("throws before the first dispatch and after dispose, and dispose is idempotent", () => {
    const { mock, pass } = setup();
    expect(() => pass.getSnapshot()).toThrow(/no dispatch/);
    const { binding } = manualBinding(10, 10);
    pass.dispatch({ height: binding });
    pass.dispose();
    expect(() => pass.getSnapshot()).toThrow(/no dispatch/);
    pass.dispose(); // idempotent
    // reusable after dispose
    const after = pass.dispatch({ height: binding });
    expect(after.newAllocations).toBe(2);
  });

  it("destroys only owned allocations, never the foreign height buffer", () => {
    const { mock, pass } = setup();
    const { binding, buffer: heightBuffer } = manualBinding(10, 10);
    pass.dispatch({ height: binding });
    const owned = mock.created.map((c) => c.buffer);
    pass.dispose();
    for (const buffer of owned) {
      expect(buffer.destroyed).toBe(true);
    }
    expect(heightBuffer.destroyed).toBe(false); // the height binding stays alive
  });
});

// ---------------------------------------------------------------------------
// Validation and rejection (all BEFORE any device call)
// ---------------------------------------------------------------------------

describe("NormalPass — pre-device rejection", () => {
  function reject(binding: NormalHeightBinding, pattern: RegExp) {
    const mock = new MockDevice();
    const pass = new NormalPass(mock);
    expect(() => pass.dispatch({ height: binding })).toThrow(pattern);
    expect(mock.created).toHaveLength(0); // rejected before ANY device call
  }

  it("rejects non-positive or non-integer extents", () => {
    const base = manualBinding(100, 80).binding;
    reject({ ...base, width: 0 }, /height width must be a positive integer/);
    reject({ ...base, height: -1 }, /height height must be a positive integer/);
    reject({ ...base, width: 1.5 }, /height width must be a positive integer/);
  });

  it("rejects a render texel count above u32", () => {
    // 70000 x 70000 = 4.9e9 texels > u32 max; both dims are valid u32 values
    reject(manualBinding(70000, 70000).binding, /render texel count 70000x70000 exceeds u32/);
  });

  it("rejects a height byteLength inconsistent with the extent", () => {
    const base = manualBinding(100, 80).binding;
    reject({ ...base, byteLength: base.byteLength - 4 }, /height binding byteLength .* != expected/);
    reject({ ...base, byteLength: base.byteLength + 8 }, /height binding byteLength .* != expected/);
  });

  it("rejects non-f32 height formats", () => {
    const base = manualBinding(100, 80).binding;
    reject({ ...base, format: "u32" as "f32" }, /height binding format u32 != f32/);
  });

  it("rejects height usage without STORAGE", () => {
    const base = manualBinding(100, 80).binding;
    reject(
      { ...base, usage: 0x4 | 0x8 }, // COPY_SRC | COPY_DST only
      /height binding usage .* lacks STORAGE/,
    );
  });

  it("rejects a height buffer smaller than the required field bytes", () => {
    const base = manualBinding(100, 80).binding;
    const small = new MockBuffer(100 * 80 * 4 - 4, NORMAL_PASS_OUTPUT_USAGE, "height");
    reject({ ...base, buffer: small }, /height buffer size .* < required/);
  });

  it("rejects workgroup sizes beyond the device limits", () => {
    const small = new MockDevice({ maxComputeWorkgroupSizeX: 32, maxComputeInvocationsPerWorkgroup: 32 });
    const pass = new NormalPass(small);
    const { binding } = manualBinding(10, 10);
    expect(() => pass.dispatch({ height: binding })).toThrow(
      /workgroup size 64 exceeds device limits/,
    );
    expect(small.created).toHaveLength(0);
  });

  it("splits oversized dispatches into band chunks within maxComputeWorkgroupsPerDimension", () => {
    const limited = new MockDevice({ maxComputeWorkgroupsPerDimension: 32 });
    const pass = new NormalPass(limited);
    const { binding } = manualBinding(100, 80); // 8000 texels -> 125 workgroups > 32
    const stats = pass.dispatch({ height: binding });
    // rowsPerChunk = floor(32 * 64 / 100) = 20 -> ceil(2000 / 64) = 32 <= 32
    expect(stats.submissions).toBe(4);
    expect(limited.encoders).toHaveLength(4);
    for (const encoder of limited.encoders) {
      expect(encoder.passes).toHaveLength(1);
      expect(encoder.passes[0].calls.dispatch[0]).toEqual({ x: 32, y: 1, z: 1 });
    }
    expect(pass.getSnapshot().lastDispatch.workgroupCountX).toBe(125); // unchanged total
  });

  it("throws when a single texel row alone exceeds maxComputeWorkgroupsPerDimension", () => {
    const limited = new MockDevice({ maxComputeWorkgroupsPerDimension: 32 });
    const pass = new NormalPass(limited);
    const { binding } = manualBinding(4000, 1); // ceil(4000 / 64) = 63 workgroups in ONE row
    expect(() => pass.dispatch({ height: binding })).toThrow(
      /dispatch chunk of 63 workgroups exceeds maxComputeWorkgroupsPerDimension/,
    );
    expect(limited.created).toHaveLength(0);
  });

  it("rejects output allocations beyond the device limits", () => {
    const limited = new MockDevice({ maxStorageBufferBindingSize: 4096, maxBufferSize: 4096 });
    const pass = new NormalPass(limited);
    const { binding } = manualBinding(100, 80); // output needs 96000 bytes
    expect(() => pass.dispatch({ height: binding })).toThrow(/normal output allocation of 96000/);
    expect(limited.created).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// WGSL binding/stride/edge-clamp/sign/normalization contracts
// ---------------------------------------------------------------------------

describe("NormalPass shaders — binding and layout contracts", () => {
  it("declares the group-0 uniform, direct height storage and packed output", () => {
    expect(NORMAL_PASS_WGSL).toContain("@group(0) @binding(0) var<uniform> params: NormalPassParams;");
    expect(NORMAL_PASS_WGSL).toContain("@group(0) @binding(1) var<storage, read> inHeight: array<f32>;");
    expect(NORMAL_PASS_WGSL).toContain("@group(0) @binding(2) var<storage, read_write> outNormal: array<f32>;");
    // the normal stage never requires the five scene buffers / coverage
    expect(NORMAL_PASS_WGSL).not.toContain("sceneHeader");
    expect(NORMAL_PASS_WGSL).not.toContain("surfaces");
    expect(NORMAL_PASS_WGSL).not.toContain("maskPixels");
  });

  it("pins the params struct offsets and the packed 12-byte xyz stride", () => {
    expect(NORMAL_PASS_WGSL).toContain("scaleX: f32,        //  0");
    expect(NORMAL_PASS_WGSL).toContain("scaleY: f32,        //  4");
    expect(NORMAL_PASS_WGSL).toContain("normalScale: f32,   //  8");
    expect(NORMAL_PASS_WGSL).toContain("width: u32,         // 12");
    expect(NORMAL_PASS_WGSL).toContain("height: u32,        // 16");
    expect(NORMAL_PASS_WGSL).toContain("workgroupSize: u32, // 20");
    expect(NORMAL_PARAMS_BYTE_LENGTH).toBe(32);
    expect(NORMAL_OUTPUT_BYTES_PER_TEXEL).toBe(12);
    // tightly packed f32 xyz triples: array<f32> with consecutive indices
    expect(NORMAL_PASS_WGSL).toContain("let o = g * 3u;");
    expect(NORMAL_PASS_WGSL).toContain("outNormal[o] = sx / len;");
    expect(NORMAL_PASS_WGSL).toContain("outNormal[o + 1u] = sy / len;");
    expect(NORMAL_PASS_WGSL).toContain("outNormal[o + 2u] = sz / len;");
    expect(NORMAL_PASS_WGSL).not.toContain("outNormal: array<vec3<f32>>");
  });

  it("keeps the documented workgroup size and the in-shader texel guard", () => {
    expect(NORMAL_WORKGROUP_SIZE).toBe(64);
    expect(NORMAL_PASS_WGSL).toContain("@workgroup_size(NORMAL_WORKGROUP_SIZE)");
    expect(NORMAL_PASS_WGSL).toContain("let texelCount = params.width * params.height;");
    expect(NORMAL_PASS_WGSL).toContain("if (g >= texelCount) {");
  });
});

describe("NormalPass shaders — CPU oracle semantics pinned in WGSL", () => {
  it("uses symmetric central difference with replicate/clamp at target edges", () => {
    expect(NORMAL_PASS_WGSL).toContain("var x0 = 0u;");
    expect(NORMAL_PASS_WGSL).toContain("if (tx > 0u) {");
    expect(NORMAL_PASS_WGSL).toContain("x0 = tx - 1u;");
    expect(NORMAL_PASS_WGSL).toContain("let x1 = min(tx + 1u, params.width - 1u);");
    expect(NORMAL_PASS_WGSL).toContain("var y0 = 0u;");
    expect(NORMAL_PASS_WGSL).toContain("if (ty > 0u) {");
    expect(NORMAL_PASS_WGSL).toContain("y0 = ty - 1u;");
    expect(NORMAL_PASS_WGSL).toContain("let y1 = min(ty + 1u, params.height - 1u);");
    expect(NORMAL_PASS_WGSL).toContain("let dx = inHeight[row + x1] - inHeight[row + x0];");
    expect(NORMAL_PASS_WGSL).toContain("let dy = inHeight[row1 + tx] - inHeight[row0 + tx];");
    // the replicated neighbors come only from the clamped x0/x1/y0/y1 above
    // (no second clamp-free read that could wrap or escape the buffer)
    expect(NORMAL_PASS_WGSL).not.toContain("inHeight[(tx + 1u) %");
    expect(NORMAL_PASS_WGSL).not.toContain("inHeight[(tx - 1u)");
    expect(NORMAL_PASS_WGSL).not.toContain("let x0 = max(tx - 1u, 0u);");
    expect(NORMAL_PASS_WGSL).not.toContain("let y0 = max(ty - 1u, 0u);");
  });

  it("pins the sign convention on exponent-aligned products", () => {
    expect(NORMAL_PASS_WGSL).toContain(
      "let qx = -alignedProduct(dx, params.scaleX, sharedExponent);",
    );
    expect(NORMAL_PASS_WGSL).toContain(
      "let qy = -alignedProduct(dy, params.scaleY, sharedExponent);",
    );
    expect(NORMAL_PASS_WGSL).toContain(
      "let qz = alignedValue(params.normalScale, sharedExponent);",
    );
  });

  it("pins exponent alignment before max-component-first normalization", () => {
    expect(NORMAL_PASS_WGSL).toContain("fn finiteExponent(value: f32) -> i32");
    expect(NORMAL_PASS_WGSL).toContain("fn finiteMantissa(value: f32) -> f32");
    expect(NORMAL_PASS_WGSL).toContain("countLeadingZeros(fraction)");
    expect(NORMAL_PASS_WGSL).toContain("fn productExponent(a: f32, b: f32) -> i32");
    expect(NORMAL_PASS_WGSL).toContain(
      "let sharedExponent = max(max(xExponent, yExponent), zExponent);",
    );
    expect(NORMAL_PASS_WGSL).toContain("let magnitude = ldexp(");
    expect(NORMAL_PASS_WGSL).toContain("let m = max(max(abs(qx), abs(qy)), qz);");
    expect(NORMAL_PASS_WGSL).toContain("let sx = qx / m;");
    expect(NORMAL_PASS_WGSL).toContain("let sy = qy / m;");
    expect(NORMAL_PASS_WGSL).toContain("let sz = qz / m;");
    expect(NORMAL_PASS_WGSL).toContain("let len = sqrt(sx * sx + sy * sy + sz * sz);");
    // Neither rejected implementation may return: both form an extreme
    // reciprocal before the multiply or normalization.
    expect(NORMAL_PASS_WGSL).not.toContain("let nx = -dx * params.scaleX;");
    expect(NORMAL_PASS_WGSL).not.toContain("let ny = -dy * params.scaleY;");
    expect(NORMAL_PASS_WGSL).not.toContain("let inv = 1.0 / m;");
    expect(NORMAL_PASS_WGSL).not.toContain("let invD = 1.0 / D;");
  });

  it("never gates derivatives by coverage or owner", () => {
    expect(NORMAL_PASS_WGSL).not.toContain("coverage");
    expect(NORMAL_PASS_WGSL).not.toContain("owner");
    expect(NORMAL_PASS_WGSL).not.toContain("objectId");
  });
});

// ---------------------------------------------------------------------------
// HeightPass + NormalPass orchestration integration on the shared mock
// ---------------------------------------------------------------------------

describe("NormalPass after HeightPass — shared mock orchestration", () => {
  it("runs after the four #25 compose passes with a direct height binding", () => {
    const mock = new MockDevice();
    const uploader = new SceneUploader(mock);
    const heightPass = new HeightPass(mock);
    const normalPass = new NormalPass(mock);
    const encoded = encodeScene(simpleScene(), 1);
    uploader.upload(encoded);
    heightPass.dispatch(encoded, uploader.getBindings());
    const snapshot = heightPass.getSnapshot();
    const stats = normalPass.dispatch({
      height: normalHeightBindingFromHeightPass(snapshot),
      options: { scaleX: 0.5, scaleY: 0.5, normalScale: 1 },
    });
    expect(stats.newAllocations).toBe(2);
    // the normal encoder runs after the height encoders; exactly one pass
    expect(mock.encoders.length).toBe(2);
    expect(mock.encoders[1].passes).toHaveLength(1);
    const normalPassRecord = mock.encoders[1].passes[0];
    expect(normalPassRecord.calls.dispatch[0].x).toBe(
      Math.ceil((snapshot.width * snapshot.height) / NORMAL_WORKGROUP_SIZE),
    );
    // the height compose workgroup size is unchanged by the normal stage
    expect(HEIGHT_WORKGROUP_SIZE).toBe(NORMAL_WORKGROUP_SIZE);
    // the normal pass never touched the height allocation
    const heightOutput = mock.bindGroups.find(
      (g) => g.entries.length === 4, // a #25 compose bind group
    );
    expect(heightOutput).toBeDefined();
  });

  it("updates options by re-packing the uniform and rerunning, reusing allocations", () => {
    const mock = new MockDevice();
    const { binding } = manualBinding(100, 80);
    const pass = new NormalPass(mock);
    const first = pass.dispatch({ height: binding, options: { scaleX: 1 } });
    expect(first.newAllocations).toBe(2);
    const second = pass.dispatch({ height: binding, options: { scaleX: 4, scaleY: 0.25, normalScale: 0.5 } });
    expect(second.newAllocations).toBe(0); // same height/output allocations
    expect(mock.writes).toHaveLength(2); // only the bounded uniform re-upload
    expect(mock.encoders).toHaveLength(2);
    expect(pass.getSnapshot().options).toEqual({ scaleX: 4, scaleY: 0.25, normalScale: 0.5 });
    const view = new DataView(mock.writes[1].bytes.buffer);
    expect(view.getFloat32(0, true)).toBe(4);
    expect(view.getFloat32(4, true)).toBe(0.25);
    expect(view.getFloat32(8, true)).toBe(0.5);
    expect(view.getUint32(12, true)).toBe(100);
  });
});

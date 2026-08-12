import { describe, expect, it } from "vitest";
import { createScene } from "../scene";
import type { Scene } from "../scene";
import { encodeScene } from "./encode";
import { HEADER_SIZE, SURFACE_STRIDE } from "./layout";
import { SceneUploader } from "./uploader";
import type { GpuBufferLike, SceneBindings } from "./uploader";
import { COMPUTE_STAGE_VISIBILITY, HeightPass } from "./height-pass";
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
  HeightPassSnapshot,
} from "./height-pass";
import {
  MAX_SHADOW_STEP_COUNT,
  SHADOW_OUTPUT_BYTES_PER_TEXEL,
  SHADOW_PARAMS_BYTE_LENGTH,
  SHADOW_PASS_WGSL,
  SHADOW_WORKGROUP_SIZE,
} from "./shadow-pass-wgsl";
import {
  SHADOW_PASS_OUTPUT_USAGE,
  ShadowPass,
  sanitizeShadowOptions,
  shadowHeightBindingsFromHeightPass,
} from "./shadow-pass";
import type { ShadowPassInput } from "./shadow-pass";
import { GPU_USAGE_STORAGE } from "./layout";

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

class MockComputePass implements GpuComputePassEncoderLike {
  readonly log: string[] = [];
  readonly calls: { pipeline: unknown; bindGroups: Array<{ index: number; bindGroup: unknown }>; dispatch: Array<{ x: number; y: number; z: number }> } = {
    pipeline: null,
    bindGroups: [],
    dispatch: [],
  };

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
// Fixture scenes
// ---------------------------------------------------------------------------

function shadowScene(): Scene {
  return createScene({
    width: 100,
    height: 80,
    surfaces: [
      {
        id: "panel",
        position: { x: 0, y: 0 },
        size: { x: 100, y: 80 },
        elevation: 0,
        thickness: 0,
        shape: { kind: "roundedRect", radius: 0 },
        profile: { kind: "flat" },
        material: "silicone",
        castsShadow: false,
        receivesShadow: true,
      },
      {
        id: "btn",
        position: { x: 30, y: 30 },
        size: { x: 20, y: 20 },
        elevation: 4,
        thickness: 0,
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

/**
 * Dispatch the height pass on `heightMock` (a normal-limit device) and
 * build the full ShadowPass input through the public helper. The ShadowPass
 * under test may use a DIFFERENT (constrained) mock: MockBuffers are
 * structural, so bindings created on one mock bind cleanly on another.
 */
function dispatchHeightAndInput(
  heightMock: MockDevice,
  scene: Scene,
  dpr = 1,
): { encoded: ReturnType<typeof encodeScene>; bindings: SceneBindings; input: ShadowPassInput } {
  const encoded = encodeScene(scene, dpr);
  const uploader = new SceneUploader(heightMock);
  uploader.upload(encoded);
  const bindings = uploader.getBindings();
  const heightPass = new HeightPass(heightMock);
  heightPass.dispatch(encoded, bindings);
  const inputs = shadowHeightBindingsFromHeightPass(heightPass.getSnapshot());
  return {
    encoded,
    bindings,
    input: {
      scene: encoded,
      bindings,
      height: inputs.height,
      casterHeight: inputs.casterHeight,
      objectId: inputs.objectId,
    },
  };
}

function setup() {
  const mock = new MockDevice();
  return { mock };
}

/** A normal-limit mock used only to produce height-pass inputs. */
function heightSetup() {
  return new MockDevice();
}

const COUNT_STORAGE = (entries: readonly GpuBindGroupLayoutEntryLike[]) =>
  entries.filter((e) => e.buffer?.type === "storage" || e.buffer?.type === "read-only-storage")
    .length;

// ---------------------------------------------------------------------------

describe("sanitizeShadowOptions — effective f32 option sanitization", () => {
  const ctx = { sceneDiagonal: Math.hypot(16, 16), lightXYLength: 0.5 };

  it("uses #17-compatible defaults", () => {
    const opts = sanitizeShadowOptions({}, ctx);
    expect(opts.stepSize).toBe(0.5);
    expect(opts.bias).toBe(Math.fround(0.5));
    expect(opts.maxDistance).toBe(Math.fround(Math.hypot(16, 16) / 0.5));
    // near-vertical light: no horizontal travel -> scene diagonal cap
    const vertical = sanitizeShadowOptions({}, { ...ctx, lightXYLength: 0 });
    expect(vertical.maxDistance).toBe(Math.fround(Math.hypot(16, 16)));
  });

  it("f32-packs the default/fallback maxDistance so snapshot, uniform and stepCount agree", () => {
    // the DEFAULT maxDistance (diagonal / |L.xy|) is an f64 value that must
    // be f32-packed BEFORE any consumer derives the step count: the
    // snapshot option, the packed uniform f32 and floor(maxDistance/step)
    // must all use the SAME f32 value
    const opts = sanitizeShadowOptions({}, { sceneDiagonal: 1 / 3, lightXYLength: 1 });
    expect(opts.maxDistance).toBe(Math.fround(1 / 3));
    expect(opts.maxDistance).not.toBe(1 / 3); // f64 default would leak otherwise
    expect(Math.floor(opts.maxDistance / 0.5)).toBe(Math.floor(Math.fround(1 / 3) / 0.5));
    // same for a fallback after an invalid maxDistance
    const fallback = sanitizeShadowOptions({ maxDistance: NaN }, ctx);
    expect(fallback.maxDistance).toBe(Math.fround(Math.hypot(16, 16) / 0.5));
  });

  it("rounds representable values to f32 and packs them unchanged", () => {
    const opts = sanitizeShadowOptions({ stepSize: 0.25, bias: 0.1, maxDistance: 8 }, ctx);
    expect(opts.stepSize).toBe(0.25);
    expect(opts.bias).toBe(Math.fround(0.1));
    expect(opts.bias).not.toBe(0.1); // f64 differs; the f32 value matches a WGSL uniform
    expect(opts.maxDistance).toBe(8);
  });

  it("falls back on NaN and infinities", () => {
    const opts = sanitizeShadowOptions(
      { stepSize: NaN, bias: Infinity, maxDistance: -Infinity },
      ctx,
    );
    expect(opts.stepSize).toBe(0.5);
    expect(opts.bias).toBe(Math.fround(0.5));
    expect(opts.maxDistance).toBe(Math.fround(Math.hypot(16, 16) / 0.5));
  });

  it("falls back on negative and zero step/maxDistance and negative bias", () => {
    const opts = sanitizeShadowOptions({ stepSize: 0, maxDistance: -1, bias: -0.25 }, ctx);
    expect(opts.stepSize).toBe(0.5);
    expect(opts.maxDistance).toBe(Math.fround(Math.hypot(16, 16) / 0.5));
    expect(opts.bias).toBe(Math.fround(0.5));
  });

  it("falls back when the raw value overflows to a non-finite f32", () => {
    const opts = sanitizeShadowOptions({ stepSize: 1e300, bias: 1e300, maxDistance: 1e300 }, ctx);
    expect(opts.stepSize).toBe(0.5);
    expect(opts.bias).toBe(Math.fround(0.5));
    expect(opts.maxDistance).toBe(Math.fround(Math.hypot(16, 16) / 0.5));
  });

  it("falls back when a positive step underflows to f32 zero", () => {
    // 5e-324 rounds to f32 0: a zero step would never advance t
    const opts = sanitizeShadowOptions({ stepSize: 5e-324 }, ctx);
    expect(opts.stepSize).toBe(0.5);
    // a zero bias is legal (bias only needs to be non-negative)
    const zeroBias = sanitizeShadowOptions({ bias: 5e-324 }, ctx);
    expect(zeroBias.bias).toBe(0);
  });

  it("falls a step that would require more than the termination cap back to 0.5", () => {
    // f32-positive but subnormal step: floor(8 / 9.8e-41) dwarfs the cap
    const opts = sanitizeShadowOptions({ stepSize: 1e-40, maxDistance: 8 }, ctx);
    expect(opts.stepSize).toBe(0.5);
  });

  it("falls a maxDistance that exceeds the cap back to the scene default", () => {
    // 1e30 / 0.5 is far above the cap, even with the default step
    const opts = sanitizeShadowOptions({ maxDistance: 1e30 }, ctx);
    expect(opts.maxDistance).toBe(Math.fround(Math.hypot(16, 16) / 0.5));
  });

  it("keeps a valid large-but-capped custom pair", () => {
    const opts = sanitizeShadowOptions({ stepSize: 1, maxDistance: 1 << 20 }, ctx);
    expect(opts.stepSize).toBe(1);
    expect(opts.maxDistance).toBe(1 << 20);
  });
});

describe("ShadowPass — pipeline caching and explicit layouts", () => {
  it("creates the shader module, layout and pipeline once and reuses them", () => {
    const { mock } = setup();
    const { input } = dispatchHeightAndInput(heightSetup(), shadowScene());
    const pass = new ShadowPass(mock);
    pass.dispatch(input);
    expect(mock.shaderModules).toHaveLength(1);
    expect(mock.shaderModules[0]).toBe(SHADOW_PASS_WGSL);
    expect(mock.bindGroupLayouts).toHaveLength(1);
    expect(mock.pipelineLayouts).toHaveLength(1);
    expect(mock.pipelines).toHaveLength(1);

    pass.dispatch(input);
    pass.dispatch({ ...input, options: { bias: 1 } });
    expect(mock.shaderModules).toHaveLength(1); // cached, no recompile
    expect(mock.bindGroupLayouts).toHaveLength(1);
    expect(mock.pipelineLayouts).toHaveLength(1);
    expect(mock.pipelines).toHaveLength(1);
  });

  it("uses an explicit pipeline layout (never layout: 'auto')", () => {
    const { mock } = setup();
    const { input } = dispatchHeightAndInput(heightSetup(), shadowScene());
    const pass = new ShadowPass(mock);
    pass.dispatch(input);
    expect(mock.pipelines[0].layout).toBe(mock.pipelineLayouts[0].layout);
    expect(mock.pipelineLayouts[0].bindGroupLayouts[0]).toBe(mock.bindGroupLayouts[0].layout);
  });

  it("pins the bind group layout entries with shader-derived minimum sizes", () => {
    const { mock } = setup();
    const { input } = dispatchHeightAndInput(heightSetup(), shadowScene());
    const pass = new ShadowPass(mock);
    pass.dispatch(input);
    const entries = mock.bindGroupLayouts[0].entries;
    expect(entries).toHaveLength(6);
    expect(entries[0]).toMatchObject({
      binding: 0,
      visibility: COMPUTE_STAGE_VISIBILITY,
      buffer: { type: "uniform", hasDynamicOffset: false, minBindingSize: SHADOW_PARAMS_BYTE_LENGTH },
    });
    for (let b = 1; b <= 4; b++) {
      expect(entries[b]).toMatchObject({
        binding: b,
        visibility: COMPUTE_STAGE_VISIBILITY,
        buffer: { type: "read-only-storage", hasDynamicOffset: false },
      });
    }
    expect(entries[4].buffer?.minBindingSize).toBe(SURFACE_STRIDE); // one SurfaceRecord
    expect(entries[5]).toMatchObject({
      binding: 5,
      visibility: COMPUTE_STAGE_VISIBILITY,
      buffer: { type: "storage", hasDynamicOffset: false, minBindingSize: SHADOW_OUTPUT_BYTES_PER_TEXEL },
    });
    // storage budget: 5 read-only + 1 output = 6 stage bindings (the
    // uniform does not count toward the per-stage storage limit)
    expect(COUNT_STORAGE(entries)).toBe(5);
  });
});

describe("ShadowPass — direct input-buffer identity and provenance", () => {
  it("binds the exact #25 height/casterHeight/objectId buffers and the uploaded surfaces", () => {
    const { mock } = setup();
    const { input } = dispatchHeightAndInput(heightSetup(), shadowScene());
    const pass = new ShadowPass(mock);
    pass.dispatch(input);
    const group = mock.bindGroups[0];
    expect(group.entries).toHaveLength(6);
    expect(group.entries[1].resource.buffer).toBe(input.height.buffer);
    expect(group.entries[2].resource.buffer).toBe(input.casterHeight.buffer);
    expect(group.entries[3].resource.buffer).toBe(input.objectId.buffer);
    expect(group.entries[4].resource.buffer).toBe(input.bindings.surfaces.buffer);
    expect(group.entries[5].resource.buffer.size).toBeGreaterThanOrEqual(100 * 80 * 4);
    expect(group.entries.map((entry) => entry.resource.size)).toEqual([
      SHADOW_PARAMS_BYTE_LENGTH,
      100 * 80 * 4,
      100 * 80 * 4,
      100 * 80 * 4,
      2 * SURFACE_STRIDE,
      100 * 80 * 4,
    ]);
    // the pass owns exactly two allocations (uniform + output); no copies of
    // the input fields exist anywhere
    expect(pass.getSnapshot().output.buffer).toBe(group.entries[5].resource.buffer);
  });

  it("binds a one-record surfaces range for an empty logical scene section", () => {
    const { mock } = setup();
    const empty = createScene({ width: 1, height: 1, surfaces: [] });
    const { input } = dispatchHeightAndInput(heightSetup(), empty);
    const pass = new ShadowPass(mock);
    pass.dispatch(input);
    expect(input.bindings.surfaces.byteLength).toBe(0);
    expect(mock.bindGroups[0].entries[4].resource.size).toBe(SURFACE_STRIDE);
  });

  it("rejects a stale/foreign height binding before any device call", () => {
    const { mock } = setup();
    const { input } = dispatchHeightAndInput(heightSetup(), shadowScene());
    const pass = new ShadowPass(mock);
    const stale = { ...input, height: { ...input.height, width: input.height.width - 1 } };
    expect(() => pass.dispatch(stale)).toThrow(/height binding extent/);
    expect(mock.created).toHaveLength(0); // rejected before any shadow allocation
  });

  it("rejects casterHeight/objectId bindings that disagree with the height binding", () => {
    const { mock } = setup();
    const { input } = dispatchHeightAndInput(heightSetup(), shadowScene());
    const pass = new ShadowPass(mock);
    expect(() =>
      pass.dispatch({ ...input, casterHeight: { ...input.casterHeight, format: "u32" } }),
    ).toThrow(/casterHeight binding format .* != f32/);
    expect(() =>
      pass.dispatch({ ...input, objectId: { ...input.objectId, format: "f32" } }),
    ).toThrow(/objectId binding format .* != u32/);
    expect(() =>
      pass.dispatch({
        ...input,
        height: { ...input.height, byteLength: input.height.byteLength - 4 },
      }),
    ).toThrow(/height binding byteLength/);
    expect(() =>
      pass.dispatch({
        ...input,
        height: { ...input.height, usage: GPU_USAGE_STORAGE | 0x4 },
      }),
    ).not.toThrow(); // COPY_SRC alone still includes STORAGE
    expect(() =>
      pass.dispatch({ ...input, objectId: { ...input.objectId, usage: 0x8 } }),
    ).toThrow(/objectId binding usage 0x8 lacks STORAGE/);
  });

  it("rejects bindings whose provenance does not match the dispatched scene", () => {
    const { mock } = setup();
    const { input } = dispatchHeightAndInput(heightSetup(), shadowScene());
    const pass = new ShadowPass(mock);
    const other = encodeScene(shadowScene(), 1);
    expect(() => pass.dispatch({ ...input, scene: other })).toThrow(/provenance/);
    expect(mock.created).toHaveLength(0);
  });

  it("rejects a foreign #25 snapshot before any device call", () => {
    const { mock } = setup();
    const { input } = dispatchHeightAndInput(heightSetup(), shadowScene());
    const pass = new ShadowPass(mock);
    // a snapshot of a DIFFERENT encoded scene (same logical content, a
    // different bytes object): the provenance identity differs even though
    // every structural check (extent/bytes/format/usage) would pass
    const other = encodeScene(shadowScene(), 1);
    const foreignProvenance = Object.freeze({
      sceneBytes: other.bytes,
      width: 100,
      height: 80,
      dpr: 1,
    });
    expect(() => pass.dispatch({
      ...input,
      height: { ...input.height, provenance: foreignProvenance },
      casterHeight: { ...input.casterHeight, provenance: foreignProvenance },
      objectId: { ...input.objectId, provenance: foreignProvenance },
    })).toThrow(/height field provenance does not match/);
    expect(mock.created).toHaveLength(0);
  });

  it("rejects fields mixed across two HeightPass dispatches of the exact same scene", () => {
    const { mock } = setup();
    const { input } = dispatchHeightAndInput(heightSetup(), shadowScene());
    const pass = new ShadowPass(mock);
    // Re-dispatch the exact same EncodedScene and uploader bindings. The
    // sceneBytes reference, extent and formats all match, but the successful
    // execution has a distinct provenance token.
    const secondHeightPass = new HeightPass(heightSetup());
    secondHeightPass.dispatch(input.scene, input.bindings);
    const second = shadowHeightBindingsFromHeightPass(secondHeightPass.getSnapshot());
    expect(second.height.provenance.sceneBytes).toBe(input.scene.bytes);
    expect(second.height.provenance).not.toBe(input.height.provenance);

    expect(() => pass.dispatch({ ...input, casterHeight: second.casterHeight })).toThrow(
      /mixed HeightPass provenance/,
    );
    expect(() => pass.dispatch({ ...input, objectId: second.objectId })).toThrow(
      /mixed HeightPass provenance/,
    );
    expect(mock.created).toHaveLength(0);
  });

  it("rejects a mismatched surfaces section before any device call", () => {
    const { mock } = setup();
    const { input } = dispatchHeightAndInput(heightSetup(), shadowScene());
    const pass = new ShadowPass(mock);
    const bad = {
      ...input.bindings,
      surfaces: { ...input.bindings.surfaces, byteLength: input.bindings.surfaces.byteLength - 128 },
    } as SceneBindings;
    expect(() => pass.dispatch({ ...input, bindings: bad })).toThrow(
      /scene surfaces binding byteLength/,
    );
    const badTotal = { ...input.bindings, sceneByteLength: input.bindings.sceneByteLength + 8 };
    expect(() => pass.dispatch({ ...input, bindings: badTotal })).toThrow(/sceneByteLength/);
    expect(mock.created).toHaveLength(0);
  });
});

describe("ShadowPass — uniform packing and caster info", () => {
  it("packs the uniform little-endian at the pinned offsets", () => {
    const { mock } = setup();
    const { input } = dispatchHeightAndInput(heightSetup(), shadowScene());
    const pass = new ShadowPass(mock);
    pass.dispatch(input);
    expect(mock.writes).toHaveLength(1); // only the params uniform
    const write = mock.writes[0];
    expect(write.bytes.byteLength).toBe(SHADOW_PARAMS_BYTE_LENGTH);
    const view = new DataView(write.bytes.buffer);
    expect(view.getFloat32(0, true)).toBe(1); // dpr
    expect(view.getUint32(4, true)).toBe(0); // pad
    expect(view.getFloat32(16, true)).toBe(Math.fround(-0.70710678)); // lx
    expect(view.getFloat32(20, true)).toBe(0); // ly
    expect(view.getFloat32(24, true)).toBe(Math.fround(0.70710678)); // lz
    expect(view.getFloat32(32, true)).toBe(0.5); // stepSize
    expect(view.getFloat32(36, true)).toBe(Math.fround(0.5)); // bias
    // the host derives the default maxDistance from the F32-packed light
    // direction (encoder-rounded), exactly like the shader's uniform
    const expectedMax =
      Math.hypot(100, 80) / Math.hypot(Math.fround(-0.70710678), Math.fround(0));
    expect(view.getFloat32(40, true)).toBe(Math.fround(expectedMax)); // maxDistance
    expect(view.getFloat32(44, true)).toBe(4); // maxCasterHeight (button top)
    expect(view.getUint32(48, true)).toBe(100); // width
    expect(view.getUint32(52, true)).toBe(80); // height
    expect(view.getUint32(56, true)).toBe(SHADOW_WORKGROUP_SIZE);
    expect(view.getUint32(60, true)).toBe(2); // surfaceCount
    expect(view.getUint32(64, true)).toBe(Math.floor(expectedMax / 0.5)); // stepCount
    expect(view.getUint32(68, true)).toBe(1); // hasCasters
    expect(view.getUint32(72, true)).toBe(0); // pad
    expect(view.getUint32(76, true)).toBe(0); // pad
  });

  it("keeps the packed uniform, the snapshot options and stepCount on the same f32 value", () => {
    const { mock } = setup();
    const { input } = dispatchHeightAndInput(heightSetup(), shadowScene());
    const pass = new ShadowPass(mock);
    pass.dispatch(input); // stable defaults (maxDistance falls back to the f32-packed default)
    const write = mock.writes[0];
    const view = new DataView(write.bytes.buffer);
    const snapshot = pass.getSnapshot();
    // the uniform f32, the reported effective option and the derived step
    // count all agree on the f32-packed default
    expect(view.getFloat32(40, true)).toBe(snapshot.options.maxDistance);
    expect(view.getFloat32(40, true)).toBe(
      Math.fround(Math.hypot(100, 80) / Math.hypot(Math.fround(-0.70710678), 0)),
    );
    expect(view.getUint32(64, true)).toBe(Math.floor(snapshot.options.maxDistance / 0.5));
    expect(snapshot.lastDispatch.stepCount).toBe(view.getUint32(64, true));
  });

  it("reports effective options and caster counters in the snapshot", () => {
    const { mock } = setup();
    const { input } = dispatchHeightAndInput(heightSetup(), shadowScene());
    const pass = new ShadowPass(mock);
    pass.dispatch({ ...input, options: { stepSize: 0.25, bias: 0.1, maxDistance: 12 } });
    const snapshot = pass.getSnapshot();
    expect(snapshot.options).toEqual({ stepSize: 0.25, bias: Math.fround(0.1), maxDistance: 12 });
    expect(snapshot.lastDispatch).toMatchObject({
      renderWidth: 100,
      renderHeight: 80,
      workgroupCountX: Math.ceil(8000 / SHADOW_WORKGROUP_SIZE),
      stepCount: 48, // floor(12 / 0.25)
      surfaceCount: 2,
      casterSurfaceCount: 1,
      maxCasterHeight: 4,
      hasCasters: true,
    });
    expect(snapshot.width).toBe(100);
    expect(snapshot.height).toBe(80);
    expect(snapshot.dpr).toBe(1);
    expect(snapshot.workgroupSize).toBe(SHADOW_WORKGROUP_SIZE);
  });

  it("reports no casters when every surface has castsShadow = false", () => {
    const { mock } = setup();
    const scene = createScene({
      width: 20,
      height: 20,
      surfaces: [
        {
          id: "ghost",
          position: { x: 3, y: 3 },
          size: { x: 10, y: 10 },
          elevation: 4,
          thickness: 1,
          shape: { kind: "roundedRect", radius: 0 },
          profile: { kind: "flat" },
          material: "silicone",
          castsShadow: false,
          receivesShadow: true,
        },
      ],
    });
    const { input } = dispatchHeightAndInput(heightSetup(), scene);
    const pass = new ShadowPass(mock);
    pass.dispatch(input);
    const snapshot = pass.getSnapshot();
    expect(snapshot.lastDispatch.hasCasters).toBe(false);
    expect(snapshot.lastDispatch.casterSurfaceCount).toBe(0);
    expect(snapshot.lastDispatch.maxCasterHeight).toBe(0);
  });
});

describe("ShadowPass — command order and dispatch dims", () => {
  it("records pipeline, bind group, ceil-division dispatch and end in order, then submits", () => {
    const { mock } = setup();
    const { input } = dispatchHeightAndInput(heightSetup(), shadowScene(), 1.5); // 150x120 = 18000 texels
    const pass = new ShadowPass(mock);
    pass.dispatch(input);
    const encoder = mock.encoders[0];
    expect(encoder.passes).toHaveLength(1);
    const compute = encoder.passes[0];
    expect(compute.calls.pipeline).toBe(mock.pipelines[0].pipeline);
    expect(compute.log).toEqual([
      "setPipeline",
      "setBindGroup(0)",
      `dispatch(${Math.ceil(18000 / SHADOW_WORKGROUP_SIZE)})`,
      "end",
    ]);
    // one invocation per render texel: ceil division of the texel count
    expect(compute.calls.dispatch[0]).toEqual({
      x: Math.ceil(18000 / SHADOW_WORKGROUP_SIZE),
      y: 1,
      z: 1,
    });
    expect(pass.getSnapshot().lastDispatch.workgroupCountX).toBe(Math.ceil(18000 / SHADOW_WORKGROUP_SIZE));
    expect(encoder.finished).toBe(true);
    expect(mock.submits).toHaveLength(1);
    expect(mock.submits[0]).toHaveLength(1);
  });

  it("updating options rewrites the uniform and redispatches without new allocations", () => {
    const { mock } = setup();
    const { input } = dispatchHeightAndInput(heightSetup(), shadowScene());
    const pass = new ShadowPass(mock);
    const first = pass.dispatch(input);
    expect(first.newAllocations).toBe(2); // uniform + output
    const second = pass.dispatch({ ...input, options: { stepSize: 1, bias: 0, maxDistance: 20 } });
    expect(second.newAllocations).toBe(0);
    expect(mock.writes).toHaveLength(2);
    expect(mock.encoders).toHaveLength(2);
    const view = new DataView(mock.writes[1].bytes.buffer);
    expect(view.getFloat32(32, true)).toBe(1); // new stepSize
    expect(view.getFloat32(36, true)).toBe(0); // new bias
    expect(view.getFloat32(40, true)).toBe(20); // new maxDistance
    expect(view.getUint32(64, true)).toBe(20); // new stepCount
    expect(pass.getSnapshot().options).toEqual({ stepSize: 1, bias: 0, maxDistance: 20 });
  });

  it("never maps or reads back during normal dispatch (no readback surface)", () => {
    const { mock } = setup();
    const { input } = dispatchHeightAndInput(heightSetup(), shadowScene());
    const pass = new ShadowPass(mock);
    pass.dispatch(input);
    const queue = mock.queue as unknown as Record<string, unknown>;
    expect(queue.mapAsync).toBeUndefined();
    expect(queue.copyBufferToBuffer).toBeUndefined();
    for (const { buffer } of mock.created) {
      const b = buffer as unknown as Record<string, unknown>;
      expect(b.mapAsync).toBeUndefined();
      expect(b.getMappedRange).toBeUndefined();
    }
  });
});

describe("ShadowPass — allocation reuse, snapshot and disposal", () => {
  it("allocates uniform + output on the first dispatch and reuses them", () => {
    const { mock } = setup();
    const { input } = dispatchHeightAndInput(heightSetup(), shadowScene());
    const pass = new ShadowPass(mock);
    const first = pass.dispatch(input);
    expect(first.newAllocations).toBe(2);
    expect(first.allocationCount).toBe(2);
    expect(mock.created).toHaveLength(2); // uniform + output only
    const shadowBuffers = mock.created.map((c) => c.buffer);
    const second = pass.dispatch(input);
    expect(second.newAllocations).toBe(0);
    expect(mock.created.map((c) => c.buffer)).toEqual(shadowBuffers);
  });

  it("grows the output when the render extent grows and disposes the old one", () => {
    const { mock } = setup();
    const { input } = dispatchHeightAndInput(heightSetup(), shadowScene()); // 100x80
    const pass = new ShadowPass(mock);
    pass.dispatch(input);
    const wide = createScene({ width: 300, height: 200, surfaces: [] });
    const wideInput = dispatchHeightAndInput(heightSetup(), wide).input;
    const grown = pass.dispatch(wideInput);
    expect(grown.newAllocations).toBe(1); // only the output grows
    expect(mock.created.some((c) => c.buffer.destroyed)).toBe(true);
    // back to a smaller extent: nothing shrinks
    const again = pass.dispatch(input);
    expect(again.newAllocations).toBe(0);
  });

  it("uses the documented usage flags and never MAP_READ", () => {
    const { mock } = setup();
    const { input } = dispatchHeightAndInput(heightSetup(), shadowScene());
    const pass = new ShadowPass(mock);
    pass.dispatch(input);
    const byLabel = new Map(mock.created.map((c) => [c.desc.label ?? "", c.desc.usage]));
    expect(byLabel.get("ukibori-uniform")).toBe(0x40 | 0x8); // UNIFORM | COPY_DST
    expect(byLabel.get("ukibori-outVisibility")).toBe(SHADOW_PASS_OUTPUT_USAGE);
    expect(SHADOW_PASS_OUTPUT_USAGE).toBe(0x80 | 0x4 | 0x8); // STORAGE | COPY_SRC | COPY_DST
    for (const { buffer } of mock.created) {
      expect(buffer.usage & 0x1).toBe(0);
    }
  });

  it("exposes a stable snapshot and throws before the first dispatch and after dispose", () => {
    const { mock } = setup();
    const { input } = dispatchHeightAndInput(heightSetup(), shadowScene());
    const pass = new ShadowPass(mock);
    expect(() => pass.getSnapshot()).toThrow(/no dispatch/);
    pass.dispatch(input);
    const snapshot = pass.getSnapshot();
    expect(snapshot.output.byteLength).toBe(100 * 80 * 4);
    expect(snapshot.output.format).toBe("f32");
    expect(snapshot.output.channels).toBe(1);
    expect(snapshot.output.usage).toBe(SHADOW_PASS_OUTPUT_USAGE);
    expect(pass.getSnapshot().output.buffer).toBe(snapshot.output.buffer); // stable
    pass.dispose();
    expect(() => pass.getSnapshot()).toThrow(/no dispatch/);
    pass.dispose(); // idempotent
  });

  it("destroys only its own allocations, never the foreign #25/uploader buffers", () => {
    const { mock } = setup();
    const { input } = dispatchHeightAndInput(heightSetup(), shadowScene());
    const pass = new ShadowPass(mock);
    pass.dispatch(input);
    const owned = mock.created.map((c) => c.buffer);
    const foreign = [
      input.height.buffer as MockBuffer,
      input.casterHeight.buffer as MockBuffer,
      input.objectId.buffer as MockBuffer,
      input.bindings.surfaces.buffer as MockBuffer,
    ];
    pass.dispose();
    for (const buffer of owned) {
      expect(buffer.destroyed).toBe(true);
    }
    for (const buffer of foreign) {
      expect(buffer.destroyed).toBe(false);
    }
  });
});

describe("ShadowPass — pre-device rejection", () => {
  it("rejects malformed encoded scenes before any device call", () => {
    const { mock } = setup();
    const { input } = dispatchHeightAndInput(heightSetup(), shadowScene());
    const pass = new ShadowPass(mock);
    const bad = { ...input, scene: { bytes: input.scene.bytes.slice(0, 64) } };
    expect(() => pass.dispatch(bad)).toThrow(/encoded scene too short/);
    expect(mock.created).toHaveLength(0); // rejected before ANY shadow allocation
  });

  it("rejects a render texel count above u32 before any device call", () => {
    const { mock } = setup();
    // the height pass cannot be used for this scene (its own u32 check would
    // reject first), so the input is built manually with structurally valid
    // bindings of the huge extent
    const huge = createScene({ width: 70000, height: 70000, surfaces: [] });
    const encoded = encodeScene(huge, 1);
    const uploader = new SceneUploader(new MockDevice());
    uploader.upload(encoded);
    const provenance = Object.freeze({
      sceneBytes: encoded.bytes,
      width: 70000,
      height: 70000,
      dpr: 1,
    });
    const field = (format: "f32" | "u32") => ({
      buffer: new MockBuffer(4 * 70000 * 70000, GPU_USAGE_STORAGE | 0x4 | 0x8),
      byteLength: 4 * 70000 * 70000,
      format,
      usage: GPU_USAGE_STORAGE | 0x4 | 0x8,
      width: 70000,
      height: 70000,
      provenance,
    });
    const pass = new ShadowPass(mock);
    expect(() =>
      pass.dispatch({
        scene: encoded,
        bindings: uploader.getBindings(),
        height: field("f32"),
        casterHeight: field("f32"),
        objectId: field("u32"),
      }),
    ).toThrow(/render texel count 70000x70000 exceeds u32/);
    expect(mock.created).toHaveLength(0);
  });

  it("rejects every oversized scalar-field binding range before creating buffers", () => {
    const mock = new MockDevice({ maxStorageBufferBindingSize: 4096, maxBufferSize: 4096 });
    const { input } = dispatchHeightAndInput(heightSetup(), shadowScene()); // output needs 32000 bytes
    const pass = new ShadowPass(mock);
    let message = "";
    try {
      pass.dispatch(input);
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("maxStorageBufferBindingSize 4096");
    expect(message).toContain("height input 32000 bytes");
    expect(message).toContain("casterHeight input 32000 bytes");
    expect(message).toContain("objectId input 32000 bytes");
    expect(message).toContain("shadow output 32000 bytes");
    expect(mock.created).toHaveLength(0);
  });

  it("rejects an oversized surfaces binding range before creating buffers", () => {
    const mock = new MockDevice({ maxStorageBufferBindingSize: 200 });
    const source = shadowScene();
    const tiny = createScene({
      width: 1,
      height: 1,
      surfaces: source.surfaces,
      light: source.light,
      materials: source.materials,
    });
    const { input } = dispatchHeightAndInput(heightSetup(), tiny);
    const pass = new ShadowPass(mock);
    expect(() => pass.dispatch(input)).toThrow(/surfaces input 256 bytes/);
    expect(mock.created).toHaveLength(0);
  });

  it("rejects unsupported workgroup sizes before any device call", () => {
    const mock = new MockDevice({ maxComputeWorkgroupSizeX: 32, maxComputeInvocationsPerWorkgroup: 32 });
    const { input } = dispatchHeightAndInput(heightSetup(), shadowScene());
    const pass = new ShadowPass(mock);
    expect(() => pass.dispatch(input)).toThrow(/workgroup size 64 exceeds device limits/);
    expect(mock.created).toHaveLength(0);
  });

  it("rejects dispatch counts beyond maxComputeWorkgroupsPerDimension", () => {
    const mock = new MockDevice({ maxComputeWorkgroupsPerDimension: 32 });
    const { input } = dispatchHeightAndInput(heightSetup(), shadowScene()); // 8000 texels -> 125 workgroups
    const pass = new ShadowPass(mock);
    expect(() => pass.dispatch(input)).toThrow(/maxComputeWorkgroupsPerDimension/);
    expect(mock.created).toHaveLength(0);
  });

  it("rejects a scene so large even the stable defaults exceed the step cap", () => {
    const { mock } = setup();
    // 4.29e9 x 1 texels is a legal u32 texel count with a diagonal of
    // ~4.29e9 scene units: floor(diagonal / 0.5) > MAX_SHADOW_STEP_COUNT.
    // The input is built manually because the height pass would reject the
    // workgroup count first.
    const huge = createScene({ width: 4294967000, height: 1, surfaces: [] });
    const encoded = encodeScene(huge, 1);
    const uploader = new SceneUploader(new MockDevice());
    uploader.upload(encoded);
    const provenance = Object.freeze({
      sceneBytes: encoded.bytes,
      width: 4294967000,
      height: 1,
      dpr: 1,
    });
    const field = (format: "f32" | "u32") => ({
      buffer: new MockBuffer(4 * 4294967000, GPU_USAGE_STORAGE | 0x4 | 0x8),
      byteLength: 4 * 4294967000,
      format,
      usage: GPU_USAGE_STORAGE | 0x4 | 0x8,
      width: 4294967000,
      height: 1,
      provenance,
    });
    const pass = new ShadowPass(mock);
    expect(() =>
      pass.dispatch({
        scene: encoded,
        bindings: uploader.getBindings(),
        height: field("f32"),
        casterHeight: field("f32"),
        objectId: field("u32"),
      }),
    ).toThrow(/exceeds the termination cap/);
    expect(mock.created).toHaveLength(0);
  });

  it("rejects a casterHeight with a mismatched buffer size", () => {
    const { mock } = setup();
    const { input } = dispatchHeightAndInput(heightSetup(), shadowScene());
    const pass = new ShadowPass(mock);
    const small = {
      ...input,
      casterHeight: {
        ...input.casterHeight,
        buffer: { ...input.casterHeight.buffer, size: 64 },
      } as unknown as typeof input.casterHeight,
    };
    expect(() => pass.dispatch(small)).toThrow(/casterHeight buffer size 64 < required/);
  });
});

// ---------------------------------------------------------------------------
// Shader/layout contract assertions. These PIN the WGSL against the host
// layout and the #17/#18 CPU shadow semantics. They are string-level checks
// only — numeric parity is the real-GPU browser test, never a mock claim.
// ---------------------------------------------------------------------------

describe("ShadowPass shader — binding contract", () => {
  it("declares the exact group-0 bindings with the documented meanings", () => {
    expect(SHADOW_PASS_WGSL).toContain("@group(0) @binding(0) var<uniform> params: ShadowPassParams;");
    expect(SHADOW_PASS_WGSL).toContain("@group(0) @binding(1) var<storage, read> inHeight: array<f32>;");
    expect(SHADOW_PASS_WGSL).toContain("@group(0) @binding(2) var<storage, read> inCasterHeight: array<f32>;");
    expect(SHADOW_PASS_WGSL).toContain("@group(0) @binding(3) var<storage, read> objectId: array<u32>;");
    expect(SHADOW_PASS_WGSL).toContain("@group(0) @binding(4) var<storage, read> surfaces: array<SurfaceRecord>;");
    expect(SHADOW_PASS_WGSL).toContain("@group(0) @binding(5) var<storage, read_write> outVisibility: array<f32>;");
    // the scene module is NOT re-declared here: only the surface records are
    // bound, never the full five-buffer scene group
    expect(SHADOW_PASS_WGSL).not.toContain("var<storage, read> sceneHeader: SceneHeader;");
  });

  it("pins the uniform struct offsets and the documented constants", () => {
    expect(SHADOW_PASS_WGSL).toContain("dpr: f32,             //  0");
    expect(SHADOW_PASS_WGSL).toContain("lightDirection: vec4<f32>, // 16");
    expect(SHADOW_PASS_WGSL).toContain("stepSize: f32,        // 32");
    expect(SHADOW_PASS_WGSL).toContain("bias: f32,            // 36");
    expect(SHADOW_PASS_WGSL).toContain("maxDistance: f32,     // 40");
    expect(SHADOW_PASS_WGSL).toContain("maxCasterHeight: f32, // 44");
    expect(SHADOW_PASS_WGSL).toContain("width: u32,           // 48");
    expect(SHADOW_PASS_WGSL).toContain("stepCount: u32,       // 64");
    expect(SHADOW_PASS_WGSL).toContain("hasCasters: u32,      // 68");
    expect(SHADOW_PASS_WGSL).toContain("const FLAG_RECEIVES_SHADOW: u32 = 0x2u;");
    expect(SHADOW_PASS_WGSL).toContain("const NO_OWNER: u32 = 0xffffffffu;");
    expect(SHADOW_PARAMS_BYTE_LENGTH).toBe(80);
    expect(SHADOW_WORKGROUP_SIZE).toBe(64);
    expect(SHADOW_OUTPUT_BYTES_PER_TEXEL).toBe(4);
    expect(MAX_SHADOW_STEP_COUNT).toBe(1 << 24);
  });

  it("keeps the documented workgroup size and in-shader bounds guard", () => {
    expect(SHADOW_PASS_WGSL).toContain("@workgroup_size(SHADOW_WORKGROUP_SIZE)");
    expect(SHADOW_PASS_WGSL).toContain("let texelCount = params.width * params.height;");
    expect(SHADOW_PASS_WGSL).toContain("if (g >= texelCount) {");
  });
});

describe("ShadowPass shader — CPU shadow semantics pinned in WGSL", () => {
  it("maps render texels through the DPR center convention", () => {
    expect(SHADOW_PASS_WGSL).toContain("let px = (f32(tx) + 0.5) / params.dpr;");
    expect(SHADOW_PASS_WGSL).toContain("let py = (f32(ty) + 0.5) / params.dpr;");
    expect(SHADOW_PASS_WGSL).toContain("let rz0 = inHeight[g];");
  });

  it("marches toward the light with the fixed signs and the inclusive pixel-center bounds", () => {
    expect(SHADOW_PASS_WGSL).toContain("let t = f32(stepIndex) * params.stepSize;");
    expect(SHADOW_PASS_WGSL).toContain("let sx = px + params.lightDirection.x * t;");
    expect(SHADOW_PASS_WGSL).toContain("let sy = py + params.lightDirection.y * t;");
    // the march bounds are the inclusive pixel-center rectangle in LOGICAL
    // scene units (render texel (tx, ty) spans [(tx + 0.5) / dpr, ...])
    expect(SHADOW_PASS_WGSL).toContain(
      "if (sx < 0.5 / params.dpr || sx > (f32(params.width) - 0.5) / params.dpr ||",
    );
    expect(SHADOW_PASS_WGSL).toContain("let rayZ = rz0 + params.lightDirection.z * t;");
  });

  it("uses the strict f32 threshold, the bias, and the conservative early exit", () => {
    expect(SHADOW_PASS_WGSL).toContain("if (sample > rayZ + params.bias) {");
    expect(SHADOW_PASS_WGSL).toContain("if (rayZ > params.maxCasterHeight + params.bias) {");
    // the blocker comparison is strictly greater: equality is lit
    expect(SHADOW_PASS_WGSL).not.toContain("sample >= rayZ");
    expect(SHADOW_PASS_WGSL).toContain("let sample = sampleCasterHeight(sx, sy);");
    expect(SHADOW_PASS_WGSL).toContain("outVisibility[g] = select(1.0, 0.0, occluded);");
  });

  it("terminates via the integer step index bounded by the host cap", () => {
    expect(SHADOW_PASS_WGSL).toContain("var stepIndex = 1u;");
    expect(SHADOW_PASS_WGSL).toContain("while (stepIndex <= params.stepCount) {");
    expect(SHADOW_PASS_WGSL).toContain("stepIndex += 1u;");
  });

  it("bilinearly samples the caster field with edge replication (sampleHeightAt)", () => {
    // logical -> interpolation coordinates use the same center convention:
    // fx = sx * dpr - 0.5 (at dpr 1 this is exactly sx - 0.5)
    expect(SHADOW_PASS_WGSL).toContain("let fx = clamp(sx * params.dpr - 0.5, 0.0, f32(params.width - 1u));");
    expect(SHADOW_PASS_WGSL).toContain("let fy = clamp(sy * params.dpr - 0.5, 0.0, f32(params.height - 1u));");
    expect(SHADOW_PASS_WGSL).toContain("let x1 = min(x0 + 1u, params.width - 1u);");
    expect(SHADOW_PASS_WGSL).toContain("let y1 = min(y0 + 1u, params.height - 1u);");
    expect(SHADOW_PASS_WGSL).toContain("let top = v00 + (v10 - v00) * tx;");
    expect(SHADOW_PASS_WGSL).toContain("let bottom = v01 + (v11 - v01) * tx;");
    expect(SHADOW_PASS_WGSL).toContain("return top + (bottom - top) * ty;");
    expect(SHADOW_PASS_WGSL).toContain("let v00 = inCasterHeight[row0 + x0];");
  });

  it("implements the receiver/background rules and the no-caster early exit", () => {
    // NO_OWNER (base plane) receives shadows; the flag gate is
    // receivesShadow (bit 1), never castsShadow
    expect(SHADOW_PASS_WGSL).toContain("let owner = objectId[g];");
    expect(SHADOW_PASS_WGSL).toContain("if (owner != NO_OWNER && owner < params.surfaceCount) {");
    expect(SHADOW_PASS_WGSL).toContain(
      "receives = (surfaces[owner].flags & FLAG_RECEIVES_SHADOW) != 0u;",
    );
    expect(SHADOW_PASS_WGSL).toContain("if (!receives) {");
    expect(SHADOW_PASS_WGSL).toContain("if (params.hasCasters == 0u) {");
  });
});

describe("shadowHeightBindingsFromHeightPass — narrow binding view of the #25 snapshot", () => {
  it("binds the exact output buffers with the snapshot extent", () => {
    const { mock } = setup();
    const encoded = encodeScene(shadowScene(), 1);
    const uploader = new SceneUploader(mock);
    uploader.upload(encoded);
    const heightPass = new HeightPass(mock);
    heightPass.dispatch(encoded, uploader.getBindings());
    const snapshot = heightPass.getSnapshot();
    const bindings = shadowHeightBindingsFromHeightPass(snapshot);
    expect(bindings.height.buffer).toBe(snapshot.outputs.height.buffer);
    expect(bindings.casterHeight.buffer).toBe(snapshot.outputs.casterHeight.buffer);
    expect(bindings.objectId.buffer).toBe(snapshot.outputs.objectId.buffer);
    for (const binding of [bindings.height, bindings.casterHeight, bindings.objectId]) {
      expect(binding.width).toBe(100);
      expect(binding.height).toBe(80);
      expect(binding.byteLength).toBe(100 * 80 * 4);
      expect(binding.usage).toBe(snapshot.outputs.height.usage);
    }
    expect(bindings.height.format).toBe("f32");
    expect(bindings.casterHeight.format).toBe("f32");
    expect(bindings.objectId.format).toBe("u32");
    // the caster-height output is a fifth independent allocation
    expect(bindings.casterHeight.buffer).not.toBe(bindings.height.buffer);
  });
});

describe("HeightPass — caster-height output on the orchestration path", () => {
  it("exposes casterHeight as a fifth tightly packed f32 output", () => {
    const { mock } = setup();
    // one height pass runs five compose passes over the scene
    const encoded = encodeScene(shadowScene(), 1);
    const uploader = new SceneUploader(mock);
    uploader.upload(encoded);
    const pass = new HeightPass(mock);
    const stats = pass.dispatch(encoded, uploader.getBindings());
    expect(stats.composePasses).toBe(5);
    const outputs = pass.getOutputs();
    expect(outputs.casterHeight.format).toBe("f32");
    expect(outputs.casterHeight.byteLength).toBe(100 * 80 * 4);
    expect(outputs.casterHeight.usage).toBe(0x80 | 0x4 | 0x8);
    expect(outputs.casterHeight.buffer).not.toBe(outputs.height.buffer);
    // the shadow pass consumes the whole snapshot directly through the
    // public helper, with the provenance tied to the same encoded scene
    const snapshot = pass.getSnapshot();
    expect(snapshot.provenance.sceneBytes).toBe(encoded.bytes);
    const shadowInputs = shadowHeightBindingsFromHeightPass(snapshot);
    const shadowPass = new ShadowPass(mock);
    shadowPass.dispatch({
      scene: encoded,
      bindings: uploader.getBindings(),
      ...shadowInputs,
    });
    expect(shadowPass.getSnapshot().lastDispatch.casterSurfaceCount).toBe(1);
  });
});

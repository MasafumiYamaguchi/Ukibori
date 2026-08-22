import { describe, expect, it } from "vitest";
import { createScene } from "../scene";
import type { Scene } from "../scene";
import { encodeScene } from "./encode";
import { HEADER_SIZE, MATERIAL_STRIDE } from "./layout";
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
import { NormalPass, normalHeightBindingFromHeightPass } from "./normal-pass";
import { ShadowPass, shadowHeightBindingsFromHeightPass } from "./shadow-pass";
import {
  LIGHTING_OUTPUT_BYTES_PER_TEXEL,
  LIGHTING_PARAMS_BYTE_LENGTH,
  LIGHTING_PASS_WGSL,
  LIGHTING_WORKGROUP_SIZE,
} from "./lighting-pass-wgsl";
import {
  DEFAULT_AMBIENT,
  LIGHTING_PASS_OUTPUT_USAGE,
  LightingPass,
  lightingMaterialIdBindingFromHeightPass,
  lightingNormalBindingFromNormalPass,
  lightingVisibilityBindingFromShadowPass,
  sanitizeAmbient,
} from "./lighting-pass";
import type { LightingFieldBinding, LightingPassInput } from "./lighting-pass";
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
  readonly calls: {
    pipeline: unknown;
    bindGroups: Array<{ index: number; bindGroup: unknown }>;
    dispatch: Array<{ x: number; y: number; z: number }>;
  } = {
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
// Fixture scene + integrated #24/#25/#26/#27 chain producing the lighting
// inputs through the public helpers (provenance propagated automatically).
// ---------------------------------------------------------------------------

function lightingScene(): Scene {
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
        material: "metal",
        castsShadow: true,
        receivesShadow: true,
      },
    ],
    light: { direction: { x: -0.70710678, y: 0, z: 0.70710678 }, intensity: 1 },
  });
}

/**
 * Run the integrated chain on one mock (SceneUploader -> HeightPass ->
 * NormalPass -> ShadowPass) and build the full LightingPass input through
 * the public helpers, with the per-HeightPass-dispatch provenance
 * propagated into the NormalPass/ShadowPass snapshots. `encoded` may be
 * supplied to run two chains on the EXACT same EncodedScene (reference-
 * identical `bytes`), as the mixed-provenance rejection test requires.
 */
function runChain(
  mock: MockDevice,
  scene: Scene,
  dpr = 1,
  encoded: ReturnType<typeof encodeScene> = encodeScene(scene, dpr),
): {
  encoded: ReturnType<typeof encodeScene>;
  bindings: SceneBindings;
  input: LightingPassInput;
} {
  const uploader = new SceneUploader(mock);
  uploader.upload(encoded);
  const bindings = uploader.getBindings();
  const heightPass = new HeightPass(mock);
  heightPass.dispatch(encoded, bindings);
  const snapshot = heightPass.getSnapshot();
  const normalPass = new NormalPass(mock);
  normalPass.dispatch({
    height: normalHeightBindingFromHeightPass(snapshot),
    options: {},
  });
  const shadowPass = new ShadowPass(mock);
  shadowPass.dispatch({
    scene: encoded,
    bindings,
    ...shadowHeightBindingsFromHeightPass(snapshot),
  });
  return {
    encoded,
    bindings,
    input: {
      scene: encoded,
      bindings,
      materialId: lightingMaterialIdBindingFromHeightPass(snapshot),
      normal: lightingNormalBindingFromNormalPass(normalPass.getSnapshot()),
      visibility: lightingVisibilityBindingFromShadowPass(shadowPass.getSnapshot()),
    },
  };
}

function setup() {
  const mock = new MockDevice();
  return { mock };
}

/**
 * Run the integrated chain on a DEDICATED mock (so the lighting pass under
 * test runs on a fresh mock whose recorded calls/allocations belong to the
 * lighting pass alone). MockBuffers are structural, so bindings created on
 * one mock bind cleanly on another.
 */
function chain(scene: Scene, dpr = 1) {
  return runChain(new MockDevice(), scene, dpr);
}

const COUNT_STORAGE = (entries: readonly GpuBindGroupLayoutEntryLike[]) =>
  entries.filter((e) => e.buffer?.type === "storage" || e.buffer?.type === "read-only-storage")
    .length;

const TEXEL_BYTES = 100 * 80 * 4;
const NORMAL_BYTES = 100 * 80 * 12;

// ---------------------------------------------------------------------------

describe("sanitizeAmbient — effective f32 ambient sanitization", () => {
  it("uses the CPU-compatible default and keeps ordinary custom values", () => {
    expect(DEFAULT_AMBIENT).toBe(0.08);
    expect(sanitizeAmbient(undefined)).toBe(Math.fround(0.08));
    expect(sanitizeAmbient(0.25)).toBe(0.25);
    expect(sanitizeAmbient(0.1)).toBe(Math.fround(0.1));
  });

  it("f32-packs representable values (f64 values round to their f32 form)", () => {
    expect(sanitizeAmbient(0.1)).toBe(Math.fround(0.1));
    expect(sanitizeAmbient(0.1)).not.toBe(0.1); // f64 differs; the packed f32 matches the uniform
  });

  it("falls back to 0.08 on NaN and infinities", () => {
    expect(sanitizeAmbient(NaN)).toBe(Math.fround(0.08));
    expect(sanitizeAmbient(Infinity)).toBe(Math.fround(0.08));
    expect(sanitizeAmbient(-Infinity)).toBe(Math.fround(0.08));
  });

  it("falls back when the raw value overflows to a non-finite f32", () => {
    expect(sanitizeAmbient(1e300)).toBe(Math.fround(0.08)); // fround -> Infinity
  });

  it("clamps representable values into [0, 1]", () => {
    expect(sanitizeAmbient(-0.5)).toBe(0);
    expect(sanitizeAmbient(-1e-3)).toBe(0);
    expect(sanitizeAmbient(2)).toBe(1);
    expect(sanitizeAmbient(0.5)).toBe(0.5);
  });

  it("preserves zero (ambient off)", () => {
    expect(sanitizeAmbient(0)).toBe(0);
  });
});

describe("LightingPass — pipeline caching, explicit layouts and the storage budget", () => {
  it("creates the shader module, layout and pipeline once and reuses them", () => {
    const { mock } = setup();
    const { input } = chain(lightingScene());
    const pass = new LightingPass(mock);
    pass.dispatch(input);
    const lightingModules = mock.shaderModules.filter((code) => code === LIGHTING_PASS_WGSL);
    const lightingLayouts = mock.bindGroupLayouts.filter(
      (l) => l.entries.length === 9,
    );
    const lightingPipelines = mock.pipelines.filter((p) => p.module.label === "ukibori-lighting-pass");
    expect(lightingModules).toHaveLength(1);
    expect(lightingLayouts).toHaveLength(1);
    expect(mock.pipelineLayouts).toHaveLength(1);
    expect(lightingPipelines).toHaveLength(1);

    pass.dispatch(input);
    pass.dispatch({ ...input, options: { ambient: 0.25 } });
    expect(lightingModules).toHaveLength(1); // cached, no recompile
    expect(lightingLayouts).toHaveLength(1);
    expect(mock.pipelineLayouts).toHaveLength(1);
    expect(lightingPipelines).toHaveLength(1);
  });

  it("uses an explicit pipeline layout (never layout: 'auto')", () => {
    const { mock } = setup();
    const { input } = chain(lightingScene());
    const pass = new LightingPass(mock);
    pass.dispatch(input);
    const lightingPipeline = mock.pipelines.find((p) => p.module.label === "ukibori-lighting-pass")!;
    expect(lightingPipeline.layout).toBe(mock.pipelineLayouts[0].layout);
    expect(mock.pipelineLayouts[0].bindGroupLayouts[0]).toBe(mock.bindGroupLayouts[0].layout);
  });

  it("pins the bind group layout entries with shader-derived minimum sizes", () => {
    const { mock } = setup();
    const { input } = chain(lightingScene());
    const pass = new LightingPass(mock);
    pass.dispatch(input);
    const entries = mock.bindGroupLayouts[0].entries;
    expect(entries).toHaveLength(9);
    expect(entries[0]).toMatchObject({
      binding: 0,
      visibility: COMPUTE_STAGE_VISIBILITY,
      buffer: { type: "uniform", hasDynamicOffset: false, minBindingSize: LIGHTING_PARAMS_BYTE_LENGTH },
    });
    for (const [binding, type, min] of [
      [1, "read-only-storage", HEADER_SIZE],
      [2, "read-only-storage", MATERIAL_STRIDE],
      [3, "read-only-storage", 4],
      [4, "read-only-storage", 12],
      [5, "read-only-storage", 4],
      [6, "storage", LIGHTING_OUTPUT_BYTES_PER_TEXEL],
      [7, "storage", LIGHTING_OUTPUT_BYTES_PER_TEXEL],
      [8, "storage", LIGHTING_OUTPUT_BYTES_PER_TEXEL],
    ] as const) {
      expect(entries[binding]).toMatchObject({
        binding,
        visibility: COMPUTE_STAGE_VISIBILITY,
        buffer: { type, hasDynamicOffset: false, minBindingSize: min },
      });
    }
    // storage budget: 5 read-only + 3 outputs = 8 stage bindings (the
    // uniform does not count toward the per-stage storage limit)
    expect(COUNT_STORAGE(entries)).toBe(8);
  });
});

describe("LightingPass — direct input-buffer identity and provenance", () => {
  it("binds the exact #25 materialId, #26 normal and #27 visibility buffers plus the uploaded header/materials", () => {
    const { mock } = setup();
    const { input } = chain(lightingScene());
    const pass = new LightingPass(mock);
    pass.dispatch(input);
    const group = mock.bindGroups[mock.bindGroups.length - 1];
    expect(group.entries).toHaveLength(9);
    expect(group.entries[1].resource.buffer).toBe(input.bindings.header.buffer);
    expect(group.entries[2].resource.buffer).toBe(input.bindings.materials.buffer);
    expect(group.entries[3].resource.buffer).toBe(input.materialId.buffer);
    expect(group.entries[4].resource.buffer).toBe(input.normal.buffer);
    expect(group.entries[5].resource.buffer).toBe(input.visibility.buffer);
    expect(group.entries.map((entry) => entry.resource.size)).toEqual([
      LIGHTING_PARAMS_BYTE_LENGTH,
      HEADER_SIZE,
      2 * MATERIAL_STRIDE,
      TEXEL_BYTES,
      NORMAL_BYTES,
      TEXEL_BYTES,
      TEXEL_BYTES,
      TEXEL_BYTES,
      TEXEL_BYTES,
    ]);
    // the pass owns exactly four allocations (uniform + three outputs); no
    // copies of the input fields exist anywhere
    expect(pass.getSnapshot().color.buffer).toBe(group.entries[8].resource.buffer);
  });

  it("binds a one-record materials range for an empty logical material table", () => {
    const { mock } = setup();
    const empty = createScene({ width: 1, height: 1, surfaces: [] });
    const { input } = chain(empty);
    const pass = new LightingPass(mock);
    pass.dispatch(input);
    expect(input.bindings.materials.byteLength).toBe(0);
    expect(mock.bindGroups[mock.bindGroups.length - 1].entries[2].resource.size).toBe(MATERIAL_STRIDE);
  });

  it("rejects bindings whose provenance does not match the dispatched scene", () => {
    const { mock } = setup();
    const { input } = chain(lightingScene());
    const pass = new LightingPass(mock);
    const other = encodeScene(lightingScene(), 1);
    expect(() => pass.dispatch({ ...input, scene: other })).toThrow(/provenance/);
    expect(mock.created).toHaveLength(0);
  });

  it("rejects a foreign #25 snapshot before any device call", () => {
    const { mock } = setup();
    const { input } = chain(lightingScene());
    const pass = new LightingPass(mock);
    // a snapshot of a DIFFERENT encoded scene (same logical content, a
    // different bytes object): the provenance identity differs even though
    // every structural check (extent/bytes/format/usage) would pass
    const other = encodeScene(lightingScene(), 1);
    const foreignProvenance = Object.freeze({
      sceneBytes: other.bytes,
      width: 100,
      height: 80,
      dpr: 1,
    });
    expect(() => pass.dispatch({
      ...input,
      normal: { ...input.normal, provenance: foreignProvenance },
      materialId: { ...input.materialId, provenance: foreignProvenance },
      visibility: { ...input.visibility, provenance: foreignProvenance },
    })).toThrow(/lighting field provenance does not match/);
    expect(mock.created).toHaveLength(0);
  });

  it("rejects fields mixed across two HeightPass dispatches of the exact same scene", () => {
    const { mock } = setup();
    // ONE encoded scene (reference-identical bytes) executed twice: the
    // sceneBytes reference, extent and formats all match, but each
    // successful execution has a distinct provenance token.
    const scene = lightingScene();
    const encoded = encodeScene(scene, 1);
    const { input } = runChain(new MockDevice(), scene, 1, encoded);
    const second = runChain(new MockDevice(), scene, 1, encoded);
    const pass = new LightingPass(mock);
    const secondNormal = second.input.normal;
    expect(secondNormal.provenance.sceneBytes).toBe(input.scene.bytes);
    expect(secondNormal.provenance).not.toBe(input.normal.provenance);

    expect(() => pass.dispatch({ ...input, normal: secondNormal })).toThrow(
      /mixed HeightPass provenance/,
    );
    expect(() =>
      pass.dispatch({ ...input, materialId: second.input.materialId }),
    ).toThrow(/mixed HeightPass provenance/);
    expect(() =>
      pass.dispatch({ ...input, visibility: second.input.visibility }),
    ).toThrow(/mixed HeightPass provenance/);
    expect(mock.created).toHaveLength(0);
  });

  it("rejects mismatched header/material sections before any device call", () => {
    const { mock } = setup();
    const { input } = chain(lightingScene());
    const pass = new LightingPass(mock);
    const shortHeader = {
      ...input.bindings,
      header: { ...input.bindings.header, byteLength: HEADER_SIZE - 4 },
    } as SceneBindings;
    expect(() => pass.dispatch({ ...input, bindings: shortHeader })).toThrow(
      /scene header binding byteLength/,
    );
    const undersizedHeader = {
      ...input.bindings,
      header: {
        ...input.bindings.header,
        buffer: { ...input.bindings.header.buffer, size: HEADER_SIZE - 4 },
      },
    } as SceneBindings;
    expect(() => pass.dispatch({ ...input, bindings: undersizedHeader })).toThrow(
      /scene header buffer size/,
    );
    const bad = {
      ...input.bindings,
      materials: {
        ...input.bindings.materials,
        byteLength: input.bindings.materials.byteLength - 64,
      },
    } as SceneBindings;
    expect(() => pass.dispatch({ ...input, bindings: bad })).toThrow(
      /scene materials binding byteLength/,
    );
    const badTotal = { ...input.bindings, sceneByteLength: input.bindings.sceneByteLength + 8 };
    expect(() => pass.dispatch({ ...input, bindings: badTotal })).toThrow(/sceneByteLength/);
    expect(mock.created).toHaveLength(0);
  });

  it("throws when building a normal binding from a synthetic (provenance-less) snapshot", () => {
    const mock = new MockDevice();
    const encoded = encodeScene(createScene({ width: 8, height: 8, surfaces: [] }), 1);
    const uploader = new SceneUploader(mock);
    uploader.upload(encoded);
    const heightPass = new HeightPass(mock);
    heightPass.dispatch(encoded, uploader.getBindings());
    const normalPass = new NormalPass(mock);
    normalPass.dispatch({
      height: {
        ...normalHeightBindingFromHeightPass(heightPass.getSnapshot()),
        provenance: undefined,
      },
    });
    expect(() => lightingNormalBindingFromNormalPass(normalPass.getSnapshot())).toThrow(
      /no HeightPass provenance/,
    );
  });
});

describe("LightingPass — uniform packing and effective ambient", () => {
  it("packs the uniform little-endian at the pinned offsets", () => {
    const { mock } = setup();
    const { input } = chain(lightingScene());
    const pass = new LightingPass(mock);
    pass.dispatch(input);
    const write = mock.writes[mock.writes.length - 1];
    expect(write.bytes.byteLength).toBe(LIGHTING_PARAMS_BYTE_LENGTH);
    const view = new DataView(write.bytes.buffer);
    expect(view.getFloat32(0, true)).toBe(Math.fround(0.08)); // default ambient
    expect(view.getUint32(4, true)).toBe(LIGHTING_WORKGROUP_SIZE);
    expect(view.getUint32(8, true)).toBe(0); // pad
    expect(view.getUint32(12, true)).toBe(0); // pad
  });

  it("packs a sanitized custom ambient and reports it in the snapshot", () => {
    const { mock } = setup();
    const { input } = chain(lightingScene());
    const pass = new LightingPass(mock);
    pass.dispatch({ ...input, options: { ambient: 0.25 } });
    const write = mock.writes[mock.writes.length - 1];
    const view = new DataView(write.bytes.buffer);
    expect(view.getFloat32(0, true)).toBe(0.25);
    expect(pass.getSnapshot().ambient).toBe(0.25);

    // invalid values fall back to f32(0.08) (packed + snapshot)
    pass.dispatch({ ...input, options: { ambient: NaN } });
    const write2 = mock.writes[mock.writes.length - 1];
    expect(new DataView(write2.bytes.buffer).getFloat32(0, true)).toBe(Math.fround(0.08));
    expect(pass.getSnapshot().ambient).toBe(Math.fround(0.08));

    // f32 overflow falls back
    pass.dispatch({ ...input, options: { ambient: 1e300 } });
    expect(pass.getSnapshot().ambient).toBe(Math.fround(0.08));

    // negative clamps to 0, above 1 clamps to 1
    pass.dispatch({ ...input, options: { ambient: -0.25 } });
    expect(pass.getSnapshot().ambient).toBe(0);
    pass.dispatch({ ...input, options: { ambient: 2 } });
    expect(pass.getSnapshot().ambient).toBe(1);
  });

  it("keeps the packed uniform and the snapshot ambient on the same f32 value", () => {
    const { mock } = setup();
    const { input } = chain(lightingScene());
    const pass = new LightingPass(mock);
    pass.dispatch({ ...input, options: { ambient: 0.1 } });
    const view = new DataView(mock.writes[mock.writes.length - 1].bytes.buffer);
    expect(view.getFloat32(0, true)).toBe(pass.getSnapshot().ambient);
    expect(pass.getSnapshot().ambient).toBe(Math.fround(0.1));
  });
});

describe("LightingPass — command order and dispatch dims", () => {
  it("records pipeline, bind group, ceil-division dispatch and end in order, then submits", () => {
    const { mock } = setup();
    const { input } = chain(lightingScene(), 1.5); // 150x120 = 18000 texels
    const pass = new LightingPass(mock);
    pass.dispatch(input);
    const encoder = mock.encoders[mock.encoders.length - 1];
    expect(encoder.passes).toHaveLength(1);
    const compute = encoder.passes[0];
    expect(compute.calls.pipeline).toBe(
      mock.pipelines.find((p) => p.module.label === "ukibori-lighting-pass")!.pipeline,
    );
    expect(compute.log).toEqual([
      "setPipeline",
      "setBindGroup(0)",
      `dispatch(${Math.ceil(18000 / LIGHTING_WORKGROUP_SIZE)})`,
      "end",
    ]);
    // one invocation per render texel: ceil division of the texel count
    expect(compute.calls.dispatch[0]).toEqual({
      x: Math.ceil(18000 / LIGHTING_WORKGROUP_SIZE),
      y: 1,
      z: 1,
    });
    expect(pass.getSnapshot().lastDispatch.workgroupCountX).toBe(
      Math.ceil(18000 / LIGHTING_WORKGROUP_SIZE),
    );
    expect(encoder.finished).toBe(true);
    expect(mock.submits).toHaveLength(1);
    expect(mock.submits[0]).toHaveLength(1);
  });

  it("updating ambient rewrites the uniform and redispatches without new allocations", () => {
    const { mock } = setup();
    const { input } = chain(lightingScene());
    const pass = new LightingPass(mock);
    const first = pass.dispatch(input);
    expect(first.newAllocations).toBe(4); // uniform + diffuse + specular + color
    const writesBefore = mock.writes.length;
    const encodersBefore = mock.encoders.length;
    const second = pass.dispatch({ ...input, options: { ambient: 0.5 } });
    expect(second.newAllocations).toBe(0);
    expect(mock.writes.length).toBe(writesBefore + 1);
    expect(mock.encoders.length).toBe(encodersBefore + 1);
    const view = new DataView(mock.writes[mock.writes.length - 1].bytes.buffer);
    expect(view.getFloat32(0, true)).toBe(0.5); // new ambient
    expect(pass.getSnapshot().ambient).toBe(0.5);
  });

  it("never maps or reads back during normal dispatch (no readback surface)", () => {
    const { mock } = setup();
    const { input } = chain(lightingScene());
    const pass = new LightingPass(mock);
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

describe("LightingPass — allocation reuse, snapshot and disposal", () => {
  it("allocates uniform + three outputs on the first dispatch and reuses them", () => {
    const { mock } = setup();
    const { input } = chain(lightingScene());
    const pass = new LightingPass(mock);
    const first = pass.dispatch(input);
    expect(first.newAllocations).toBe(4);
    expect(first.allocationCount).toBe(4);
    const firstCreated = mock.created.length;
    const second = pass.dispatch(input);
    expect(second.newAllocations).toBe(0);
    expect(mock.created.length).toBe(firstCreated);
  });

  it("grows the outputs when the render extent grows and disposes the old ones", () => {
    const { mock } = setup();
    const { input } = chain(lightingScene()); // 100x80
    const pass = new LightingPass(mock);
    pass.dispatch(input);
    const firstOutputs = [
      pass.getSnapshot().diffuse.buffer,
      pass.getSnapshot().specular.buffer,
      pass.getSnapshot().color.buffer,
    ];
    const wide = createScene({ width: 300, height: 200, surfaces: [] });
    const wideInput = chain(wide).input;
    const grown = pass.dispatch(wideInput);
    expect(grown.newAllocations).toBe(3); // only the three outputs grow
    for (const buffer of firstOutputs as MockBuffer[]) {
      expect(buffer.destroyed).toBe(true); // the old lighting outputs were disposed
    }
    // back to a smaller extent: nothing shrinks
    const again = pass.dispatch(input);
    expect(again.newAllocations).toBe(0);
  });

  it("uses the documented usage flags and never MAP_READ", () => {
    const { mock } = setup();
    const { input } = chain(lightingScene());
    const pass = new LightingPass(mock);
    pass.dispatch(input);
    const byLabel = new Map(mock.created.map((c) => [c.desc.label ?? "", c.desc.usage]));
    expect(LIGHTING_PASS_OUTPUT_USAGE).toBe(0x80 | 0x4 | 0x8); // STORAGE | COPY_SRC | COPY_DST
    for (const label of ["ukibori-outDiffuse", "ukibori-outSpecular", "ukibori-outColor"]) {
      expect(byLabel.get(label)).toBe(LIGHTING_PASS_OUTPUT_USAGE);
    }
    // the last uniform allocation belongs to the lighting pass
    const lightingUniform = mock.created.filter((c) => c.desc.label === "ukibori-uniform").at(-1)!;
    expect(lightingUniform.desc.usage).toBe(0x40 | 0x8); // UNIFORM | COPY_DST
    expect(lightingUniform.desc.size).toBe(LIGHTING_PARAMS_BYTE_LENGTH);
    for (const { buffer } of mock.created) {
      expect(buffer.usage & 0x1).toBe(0);
    }
  });

  it("exposes a stable snapshot and throws before the first dispatch and after dispose", () => {
    const { mock } = setup();
    const { input } = chain(lightingScene());
    const pass = new LightingPass(mock);
    expect(() => pass.getSnapshot()).toThrow(/no dispatch/);
    pass.dispatch(input);
    const snapshot = pass.getSnapshot();
    expect(snapshot.width).toBe(100);
    expect(snapshot.height).toBe(80);
    expect(snapshot.dpr).toBe(1);
    expect(snapshot.workgroupSize).toBe(LIGHTING_WORKGROUP_SIZE);
    expect(snapshot.ambient).toBe(Math.fround(DEFAULT_AMBIENT));
    for (const output of [snapshot.diffuse, snapshot.specular]) {
      expect(output.byteLength).toBe(TEXEL_BYTES);
      expect(output.format).toBe("f32");
      expect(output.channels).toBe(1);
      expect(output.usage).toBe(LIGHTING_PASS_OUTPUT_USAGE);
    }
    expect(snapshot.color.byteLength).toBe(TEXEL_BYTES);
    expect(snapshot.color.format).toBe("rgba8");
    expect(snapshot.color.channels).toBe(4);
    expect(snapshot.color.usage).toBe(LIGHTING_PASS_OUTPUT_USAGE);
    expect(snapshot.lastDispatch).toEqual({
      renderWidth: 100,
      renderHeight: 80,
      workgroupCountX: Math.ceil(8000 / LIGHTING_WORKGROUP_SIZE),
    });
    expect(pass.getSnapshot().color.buffer).toBe(snapshot.color.buffer); // stable
    pass.dispose();
    expect(() => pass.getSnapshot()).toThrow(/no dispatch/);
    pass.dispose(); // idempotent
  });

  it("destroys only its own allocations, never the foreign chain/uploader buffers", () => {
    const { mock } = setup();
    const { input } = chain(lightingScene());
    const pass = new LightingPass(mock);
    pass.dispatch(input);
    const lightingCreated = mock.created.slice(-4).map((c) => c.buffer);
    const foreign = [
      input.bindings.header.buffer,
      input.bindings.materials.buffer,
      input.materialId.buffer,
      input.normal.buffer,
      input.visibility.buffer,
    ] as MockBuffer[];
    pass.dispose();
    for (const buffer of lightingCreated) {
      expect(buffer.destroyed).toBe(true);
    }
    for (const buffer of foreign) {
      expect(buffer.destroyed).toBe(false);
    }
  });
});

describe("LightingPass — pre-device rejection", () => {
  it("rejects malformed encoded scenes before any device call", () => {
    const { mock } = setup();
    const { input } = chain(lightingScene());
    const pass = new LightingPass(mock);
    const bad = { ...input, scene: { bytes: input.scene.bytes.slice(0, 64) } };
    expect(() => pass.dispatch(bad)).toThrow(/encoded scene too short/);
    expect(mock.created).toHaveLength(0); // rejected before ANY lighting allocation
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
    const field = (format: "f32" | "u32", channels: 1 | 3, bytes: number) => ({
      buffer: new MockBuffer(bytes, GPU_USAGE_STORAGE | 0x4 | 0x8),
      byteLength: bytes,
      format,
      channels,
      usage: GPU_USAGE_STORAGE | 0x4 | 0x8,
      width: 70000,
      height: 70000,
      provenance,
    });
    const pass = new LightingPass(mock);
    expect(() =>
      pass.dispatch({
        scene: encoded,
        bindings: uploader.getBindings(),
        materialId: field("u32", 1, 4 * 70000 * 70000),
        normal: field("f32", 3, 12 * 70000 * 70000),
        visibility: field("f32", 1, 4 * 70000 * 70000),
      }),
    ).toThrow(/render texel count 70000x70000 exceeds u32/);
    expect(mock.created).toHaveLength(0);
  });

  it("rejects unsupported workgroup sizes and storage budgets before any device call", () => {
    const smallWg = new MockDevice({ maxComputeWorkgroupSizeX: 32, maxComputeInvocationsPerWorkgroup: 32 });
    const { input } = runChain(new MockDevice(), lightingScene());
    const pass1 = new LightingPass(smallWg);
    expect(() => pass1.dispatch(input)).toThrow(/workgroup size 64 exceeds device limits/);
    expect(smallWg.created).toHaveLength(0);

    const lowStorage = new MockDevice({ maxStorageBuffersPerShaderStage: 7 });
    const pass2 = new LightingPass(lowStorage);
    expect(() => pass2.dispatch(input)).toThrow(/maxStorageBuffersPerShaderStage 7 < 8/);
    expect(lowStorage.created).toHaveLength(0);
  });

  it("splits oversized dispatches into band chunks within maxComputeWorkgroupsPerDimension", () => {
    const mock = new MockDevice({ maxComputeWorkgroupsPerDimension: 32 });
    const { input } = runChain(new MockDevice(), lightingScene()); // 8000 texels -> 125 workgroups
    const pass = new LightingPass(mock);
    // rowsPerChunk = floor(32 * 64 / 100) = 20 -> ceil(2000 / 64) = 32 <= 32
    const stats = pass.dispatch(input);
    expect(stats.submissions).toBe(4);
    expect(mock.encoders).toHaveLength(4);
    for (const encoder of mock.encoders) {
      expect(encoder.passes).toHaveLength(1);
      expect(encoder.passes[0].calls.dispatch[0]).toEqual({ x: 32, y: 1, z: 1 });
    }
    expect(pass.getSnapshot().lastDispatch.workgroupCountX).toBe(125); // unchanged total
  });

  it("rejects every oversized binding range before creating buffers", () => {
    const mock = new MockDevice({ maxStorageBufferBindingSize: 4096, maxBufferSize: 4096 });
    const { input } = runChain(new MockDevice(), lightingScene()); // outputs need 32000 bytes
    const pass = new LightingPass(mock);
    let message = "";
    try {
      pass.dispatch(input);
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("maxStorageBufferBindingSize 4096");
    expect(message).toContain("materialId input 32000 bytes");
    expect(message).toContain("normal input 96000 bytes");
    expect(message).toContain("visibility input 32000 bytes");
    expect(message).toContain("diffuse output 32000 bytes");
    expect(mock.created).toHaveLength(0);
  });

  it("rejects a normal binding with a mismatched byte length", () => {
    const { mock } = setup();
    const { input } = chain(lightingScene());
    const pass = new LightingPass(mock);
    const bad = { ...input, normal: { ...input.normal, byteLength: input.normal.byteLength - 12 } };
    expect(() => pass.dispatch(bad)).toThrow(/normal binding byteLength/);
    expect(mock.created).toHaveLength(0);
  });

  it("rejects wrong field formats/channels or missing STORAGE", () => {
    const { mock } = setup();
    const { input } = chain(lightingScene());
    const pass = new LightingPass(mock);
    expect(() =>
      pass.dispatch({ ...input, materialId: { ...input.materialId, format: "f32" } }),
    ).toThrow(/materialId binding format .* != u32/);
    expect(() =>
      pass.dispatch({ ...input, visibility: { ...input.visibility, format: "u32" } }),
    ).toThrow(/visibility binding format .* != f32/);
    expect(() =>
      pass.dispatch({ ...input, normal: { ...input.normal, channels: 1 } }),
    ).toThrow(/normal binding channels 1 != 3/);
    expect(() =>
      pass.dispatch({ ...input, visibility: { ...input.visibility, channels: 3 } }),
    ).toThrow(/visibility binding channels 3 != 1/);
    expect(() =>
      pass.dispatch({ ...input, visibility: { ...input.visibility, usage: 0x8 } }),
    ).toThrow(/visibility binding usage 0x8 lacks STORAGE/);
    expect(() =>
      pass.dispatch({ ...input, normal: { ...input.normal, usage: GPU_USAGE_STORAGE | 0x4 } }),
    ).not.toThrow(); // COPY_SRC alone still includes STORAGE
  });

  it("rejects an extent mismatch between a field binding and the header", () => {
    const { mock } = setup();
    const { input } = chain(lightingScene());
    const pass = new LightingPass(mock);
    const stale = { ...input, normal: { ...input.normal, width: input.normal.width - 1 } };
    expect(() => pass.dispatch(stale)).toThrow(/normal binding extent/);
    expect(mock.created).toHaveLength(0);
  });

  it("rejects a normal binding whose buffer does not cover the logical bytes", () => {
    const { mock } = setup();
    const { input } = chain(lightingScene());
    const pass = new LightingPass(mock);
    const small = {
      ...input,
      normal: {
        ...input.normal,
        buffer: { ...input.normal.buffer, size: 64 },
      } as unknown as LightingFieldBinding,
    };
    expect(() => pass.dispatch(small)).toThrow(/normal buffer size 64 < required/);
  });
});

// ---------------------------------------------------------------------------
// Shader/layout contract assertions. These PIN the WGSL against the host
// layout and the #16/#22/#28 CPU lighting semantics. They are string-level
// checks only — numeric parity is the real-GPU browser test, never a mock
// claim.
// ---------------------------------------------------------------------------

describe("LightingPass shader — binding contract", () => {
  it("declares the exact group-0 bindings with the documented meanings", () => {
    expect(LIGHTING_PASS_WGSL).toContain("@group(0) @binding(0) var<uniform> params: LightingPassParams;");
    expect(LIGHTING_PASS_WGSL).toContain("@group(0) @binding(1) var<storage, read> sceneHeader: SceneHeader;");
    expect(LIGHTING_PASS_WGSL).toContain("@group(0) @binding(2) var<storage, read> materials: array<MaterialRecord>;");
    expect(LIGHTING_PASS_WGSL).toContain("@group(0) @binding(3) var<storage, read> materialId: array<u32>;");
    expect(LIGHTING_PASS_WGSL).toContain("@group(0) @binding(4) var<storage, read> inNormal: array<f32>;");
    expect(LIGHTING_PASS_WGSL).toContain("@group(0) @binding(5) var<storage, read> inVisibility: array<f32>;");
    expect(LIGHTING_PASS_WGSL).toContain("@group(0) @binding(6) var<storage, read_write> outDiffuse: array<f32>;");
    expect(LIGHTING_PASS_WGSL).toContain("@group(0) @binding(7) var<storage, read_write> outSpecular: array<f32>;");
    expect(LIGHTING_PASS_WGSL).toContain("@group(0) @binding(8) var<storage, read_write> outColor: array<u32>;");
  });

  it("pins the uniform struct offsets and the documented constants", () => {
    expect(LIGHTING_PASS_WGSL).toContain("ambient: f32,          //  0");
    expect(LIGHTING_PASS_WGSL).toContain("workgroupSize: u32,    //  4");
    expect(LIGHTING_PARAMS_BYTE_LENGTH).toBe(16);
    expect(LIGHTING_WORKGROUP_SIZE).toBe(64);
    expect(LIGHTING_OUTPUT_BYTES_PER_TEXEL).toBe(4);
  });

  it("keeps the documented workgroup size and in-shader bounds guard", () => {
    expect(LIGHTING_PASS_WGSL).toContain("@workgroup_size(LIGHTING_WORKGROUP_SIZE)");
    expect(LIGHTING_PASS_WGSL).toContain("let texelCount = width * height;");
    expect(LIGHTING_PASS_WGSL).toContain("if (g >= texelCount) {");
  });
});

describe("LightingPass shader — #16 BRDF formulas pinned in WGSL", () => {
  it("regularizes the GGX alpha and pins the NDF", () => {
    expect(LIGHTING_PASS_WGSL).toContain("const GGX_ALPHA_EPS: f32 = 1e-4;");
    expect(LIGHTING_PASS_WGSL).toContain("return max(roughness * roughness, GGX_ALPHA_EPS);");
    expect(LIGHTING_PASS_WGSL).toContain("let denom = max(nDotH * nDotH * (a2 - 1.0) + 1.0, GGX_DENOM_EPS);");
    expect(LIGHTING_PASS_WGSL).toContain("return a2 / (PI * denom * denom);");
  });

  it("pins height-correlated Smith visibility with the shared alpha", () => {
    expect(LIGHTING_PASS_WGSL).toContain("let gv = nDotL * sqrt(nDotV * nDotV * (1.0 - a2) + a2);");
    expect(LIGHTING_PASS_WGSL).toContain("let gl = nDotV * sqrt(nDotL * nDotL * (1.0 - a2) + a2);");
    expect(LIGHTING_PASS_WGSL).toContain("return 0.5 / denom;");
  });

  it("pins Schlick Fresnel, dielectric F0 and the metallic mix", () => {
    expect(LIGHTING_PASS_WGSL).toContain("let c = clamp(cosTheta, 0.0, 1.0);");
    expect(LIGHTING_PASS_WGSL).toContain("let t = pow(1.0 - c, 5.0);");
    expect(LIGHTING_PASS_WGSL).toContain("return f0 + (vec3<f32>(1.0) - f0) * t;");
    expect(LIGHTING_PASS_WGSL).toContain("let v = (ior - 1.0) / (ior + 1.0);");
    expect(LIGHTING_PASS_WGSL).toContain("return v * v;");
    expect(LIGHTING_PASS_WGSL).toContain("return f0d + (m.baseColor - vec3<f32>(f0d)) * m.metallic;");
  });

  it("pins Lambert 1/PI, metals with no diffuse, and the debug outputs", () => {
    expect(LIGHTING_PASS_WGSL).toContain("brdfDiffuse = (base * (vec3<f32>(1.0) - f) * (1.0 - m.metallic)) / PI;");
    expect(LIGHTING_PASS_WGSL).toContain("outDiffuse[g] = cosine;");
    expect(LIGHTING_PASS_WGSL).toContain("outSpecular[g] = specularOutput(brdfSpecular, cosine, vis);");
    expect(LIGHTING_PASS_WGSL).toContain("return min(luminance(specular) * cosine * vis, 1.0);");
  });

  it("pins the direct-only visibility scaling and the #22 environment", () => {
    expect(LIGHTING_PASS_WGSL).toContain("let direct = satMul(satMul(intensity, cosine), vis);");
    expect(LIGHTING_PASS_WGSL).toContain("let envDiffuse = base * (1.0 - m.metallic) * diffuseScale;");
    expect(LIGHTING_PASS_WGSL).toContain("let envSpecular = specularScale * (f0 + (vec3<f32>(1.0) - f0) * t);");
    expect(LIGHTING_PASS_WGSL).toContain("let t = pow(1.0 - m.roughness, 5.0);");
  });

  it("pins the saturated accumulation, the exposure order and the sRGB encoder", () => {
    expect(LIGHTING_PASS_WGSL).toContain("return min(a + b, F32_MAX);");
    expect(LIGHTING_PASS_WGSL).toContain("if (a == 0.0 || b == 0.0) {");
    expect(LIGHTING_PASS_WGSL).toContain("return min(a * b, F32_MAX);");
    expect(LIGHTING_PASS_WGSL).toContain("let exposedR = satMul(linear.r, exposure);");
    expect(LIGHTING_PASS_WGSL).toContain("let encoded = select(1.055 * pow(c, 1.0 / 2.4) - 0.055, c * 12.92, c <= 0.0031308);");
    expect(LIGHTING_PASS_WGSL).toContain("return u32(floor(encoded * 255.0 + 0.5));");
    expect(LIGHTING_PASS_WGSL).toContain("return r | (g << 8u) | (b << 16u) | 0xff000000u;");
  });

  it("handles the degenerate half vector and material fallback without OOB reads", () => {
    expect(LIGHTING_PASS_WGSL).toContain("if (cosine > 0.0 && nDotV > 0.0 && hLen > 0.0) {");
    expect(LIGHTING_PASS_WGSL).toContain("let hLen = sqrt(lx * lx + ly * ly + (lz + 1.0) * (lz + 1.0));");
    expect(LIGHTING_PASS_WGSL).toContain("let nDotVH = hz; // V = (0,0,1) -> V·H == H.z");
    // base material + defensive invalid-id fallback; NO_OWNER never indexes
    expect(LIGHTING_PASS_WGSL).toContain("m.baseColor = vec3<f32>(0.6, 0.6, 0.6);");
    expect(LIGHTING_PASS_WGSL).toContain("if (owner == NO_OWNER) {");
    expect(LIGHTING_PASS_WGSL).toContain("if (owner < sceneHeader.materialCount) {");
    expect(LIGHTING_PASS_WGSL).toContain("return materials[owner];");
  });
});

describe("WebGpuBackend — capabilities.compute stays false until #29", () => {
  it("reports compute: false (no public GPU selection before presentation)", async () => {
    const { WebGpuBackend } = await import("../backend/webgpu");
    // the backend skeleton must not claim compute support while the lighting
    // loop is still internal-only (#29 owns the public selection)
    const backend = new WebGpuBackend({ destroy() {} } as never);
    expect(backend.capabilities.backend).toBe("webgpu");
    expect(backend.capabilities.compute).toBe(false);
    backend.dispose();
  });
});

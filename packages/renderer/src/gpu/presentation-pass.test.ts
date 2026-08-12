import { describe, expect, it } from "vitest";
import { createScene } from "../scene";
import type { Scene } from "../scene";
import { encodeScene } from "./encode";
import { GPU_USAGE_STORAGE, HEADER_SIZE } from "./layout";
import { SceneUploader } from "./uploader";
import type { GpuBufferLike, SceneBindings } from "./uploader";
import { HeightPass } from "./height-pass";
import type {
  GpuBindGroupEntryLike,
  GpuBindGroupLayoutEntryLike,
  GpuBindGroupLayoutLike,
  GpuBindGroupLike,
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
import { LightingPass, lightingMaterialIdBindingFromHeightPass, lightingNormalBindingFromNormalPass, lightingVisibilityBindingFromShadowPass } from "./lighting-pass";
import {
  PRESENTATION_PARAMS_BYTE_LENGTH,
  PRESENTATION_PASS_WGSL,
} from "./presentation-pass-wgsl";
import {
  compositeShadowPremultipliedBytes,
  compositeShadowAlphaByte,
  DEFAULT_SHADOW_ALPHA,
  DEFAULT_SHADOW_COLOR,
  sanitizeCompositeOptions,
} from "./composite";
import {
  FRAGMENT_STAGE_VISIBILITY,
  GPU_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_COPY_SRC,
  PRESENTATION_ALPHA_MODE,
  PRESENTATION_COLOR_SPACE,
  PresentationPass,
  presentationColorBindingFromLightingPass,
  presentationObjectIdBindingFromHeightPass,
  presentationVisibilityBindingFromShadowPass,
} from "./presentation-pass";
import type {
  GpuCanvasConfigurationLike,
  GpuCanvasContextLike,
  GpuPresentationDeviceLike,
  GpuPresentationEncoderLike,
  GpuPresentationLimitsLike,
  GpuRenderPassEncoderLike,
  GpuRenderPipelineLike,
  GpuTextureLike,
  GpuTextureViewLike,
  PresentationInputBinding,
  PresentationPassInput,
} from "./presentation-pass";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Mocks: the same structural-surface pattern as the compute-pass tests — the
// real GPUDevice/GPUCanvasContext casts happen at the harness boundary only.
// ---------------------------------------------------------------------------

class MockBuffer implements GpuBufferLike {
  destroyed = false;
  constructor(
    readonly size: number,
    readonly usage = 0,
    readonly label?: string,
  ) {}
  destroy(): void {
    this.destroyed = true;
  }
}

class MockTexture implements GpuTextureLike {
  readonly view: GpuTextureViewLike = { label: "ukibori-mock-view" };
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}
  createView(): GpuTextureViewLike {
    return this.view;
  }
}

class MockRenderPass implements GpuRenderPassEncoderLike {
  readonly log: string[] = [];
  readonly calls: {
    pipeline: GpuRenderPipelineLike | null;
    bindGroups: Array<{ index: number; bindGroup: unknown }>;
    draws: number[];
  } = { pipeline: null, bindGroups: [], draws: [] };
  desc: unknown = null;

  setPipeline(pipeline: GpuRenderPipelineLike): void {
    this.calls.pipeline = pipeline;
    this.log.push("setPipeline");
  }
  setBindGroup(index: number, bindGroup: unknown): void {
    this.calls.bindGroups.push({ index, bindGroup });
    this.log.push(`setBindGroup(${index})`);
  }
  draw(vertexCount: number): void {
    this.calls.draws.push(vertexCount);
    this.log.push(`draw(${vertexCount})`);
  }
  end(): void {
    this.log.push("end");
  }
}

class MockPresentationEncoder implements GpuPresentationEncoderLike {
  readonly passes: MockRenderPass[] = [];
  finished = false;
  beginRenderPass(desc: never): GpuRenderPassEncoderLike {
    const pass = new MockRenderPass();
    pass.desc = desc;
    this.passes.push(pass);
    return pass;
  }
  finish(): { label?: string } {
    this.finished = true;
    return { label: "mock-presentation-cmd" };
  }
}

class MockCanvasContext implements GpuCanvasContextLike {
  readonly canvas: { width: number; height: number };
  readonly configured: GpuCanvasConfigurationLike[] = [];
  readonly textures: MockTexture[] = [];
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
    const texture = new MockTexture(this.canvas.width, this.canvas.height);
    this.textures.push(texture);
    return texture;
  }
}

class MockPresentationDevice implements GpuPresentationDeviceLike {
  readonly limits: GpuPresentationLimitsLike;
  readonly created: Array<{ desc: { size: number; usage: number; label?: string }; buffer: MockBuffer }> = [];
  readonly shaderModules: string[] = [];
  readonly renderPipelines: Array<{
    layout: unknown;
    vertex: { module: unknown; entryPoint: string };
    fragment: { module: unknown; entryPoint: string; targets: readonly { format: string }[] };
    primitive?: { topology: string };
    pipeline: GpuRenderPipelineLike;
  }> = [];
  readonly bindGroupLayouts: Array<{
    entries: GpuBindGroupLayoutEntryLike[];
    layout: unknown;
  }> = [];
  readonly pipelineLayouts: Array<{ bindGroupLayouts: unknown[]; layout: unknown }> = [];
  readonly bindGroups: Array<{ layout: unknown; entries: GpuBindGroupEntryLike[] }> = [];
  readonly encoders: MockPresentationEncoder[] = [];
  readonly writes: Array<{ buffer: MockBuffer; dstByteOffset: number; bytes: Uint8Array }> = [];
  readonly submits: Array<Array<{ label?: string }>> = [];
  private resolveLost: ((value: unknown) => void) | null = null;
  readonly lost: Promise<unknown>;

  constructor(limits: Partial<GpuPresentationLimitsLike> = {}) {
    this.limits = {
      maxStorageBufferBindingSize: 1 << 28,
      maxBufferSize: 1 << 28,
      maxUniformBufferBindingSize: 16 * 1024,
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
    writeBuffer: (buffer: GpuBufferLike, dstByteOffset: number, source: Uint8Array): void => {
      const mock = buffer as MockBuffer;
      this.writes.push({ buffer: mock, dstByteOffset, bytes: source.slice() });
    },
    submit: (commandBuffers: readonly { label?: string }[]): void => {
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

  createRenderPipeline(desc: {
    layout: GpuPipelineLayoutLike;
    vertex: { module: GpuShaderModuleLike; entryPoint: string };
    fragment: { module: GpuShaderModuleLike; entryPoint: string; targets: readonly { format: string }[] };
    primitive?: { topology: string };
    label?: string;
  }): GpuRenderPipelineLike {
    const pipeline = { label: desc.label };
    this.renderPipelines.push({
      layout: desc.layout,
      vertex: desc.vertex,
      fragment: desc.fragment,
      primitive: desc.primitive,
      pipeline,
    });
    return pipeline;
  }

  createBindGroupLayout(desc: { entries: readonly GpuBindGroupLayoutEntryLike[]; label?: string }): GpuBindGroupLayoutLike {
    const layout = { label: desc.label };
    this.bindGroupLayouts.push({ entries: [...desc.entries], layout });
    return layout;
  }

  createPipelineLayout(desc: { bindGroupLayouts: readonly GpuBindGroupLayoutLike[]; label?: string }): GpuPipelineLayoutLike {
    const layout = { label: desc.label };
    this.pipelineLayouts.push({ bindGroupLayouts: [...desc.bindGroupLayouts], layout });
    return layout;
  }

  createBindGroup(desc: { layout: GpuBindGroupLayoutLike; entries: readonly GpuBindGroupEntryLike[]; label?: string }): GpuBindGroupLike {
    const bindGroup = { label: desc.label };
    this.bindGroups.push({ layout: desc.layout, entries: [...desc.entries] });
    return bindGroup;
  }

  createCommandEncoder(): GpuPresentationEncoderLike {
    const encoder = new MockPresentationEncoder();
    this.encoders.push(encoder);
    return encoder;
  }
}

// ---------------------------------------------------------------------------
// Chain builder: SceneUploader -> HeightPass -> NormalPass -> ShadowPass ->
// LightingPass on a compute mock (provenance propagated automatically), so
// the presentation inputs are REAL chain outputs.
// ---------------------------------------------------------------------------

function presentationScene(): Scene {
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
 * The proven compute-pass mock from the existing pass tests: a pass encoder
 * with setPipeline / setBindGroup / dispatchWorkgroups / end. The #29 chain
 * builder runs the REAL Height/Normal/Shadow/Lighting passes through it, so
 * the presentation inputs are real chain outputs (provenance propagated).
 */
class MockComputePass implements GpuComputePassEncoderLike {
  setPipeline(_pipeline: GpuComputePipelineLike): void {}
  setBindGroup(_index: number, _bindGroup: GpuBindGroupLike): void {}
  dispatchWorkgroups(_x: number, _y = 1, _z = 1): void {}
  end(): void {}
}

class MockComputeDevice implements GpuComputeDeviceLike {
  readonly limits: GpuLimitsLike;
  readonly created: MockBuffer[] = [];
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
    writeBuffer: (): void => undefined,
    submit: (): void => undefined,
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
  createBindGroupLayout(desc: { label?: string }): GpuBindGroupLayoutLike {
    return { label: desc.label };
  }
  createPipelineLayout(desc: { label?: string }): GpuPipelineLayoutLike {
    return { label: desc.label };
  }
  createBindGroup(desc: { label?: string }): GpuBindGroupLike {
    return { label: desc.label };
  }
  createCommandEncoder(desc?: { label?: string }): {
    beginComputePass(): GpuComputePassEncoderLike;
    finish(): { label?: string };
  } {
    return {
      beginComputePass(): GpuComputePassEncoderLike {
        // The same proven compute-pass mock behavior as the existing pass
        // tests: the full #25/#26/#27/#28 chain runs through this encoder.
        const pass = new MockComputePass();
        return pass;
      },
      finish(): { label?: string } {
        return { label: desc?.label };
      },
    };
  }
}

function runChain(
  mock: MockComputeDevice,
  scene: Scene,
  dpr = 1,
  encoded: ReturnType<typeof encodeScene> = encodeScene(scene, dpr),
): {
  encoded: ReturnType<typeof encodeScene>;
  bindings: SceneBindings;
  height: HeightPassSnapshot;
  input: PresentationPassInput;
} {
  const uploader = new SceneUploader(mock);
  uploader.upload(encoded);
  const bindings = uploader.getBindings();
  const heightPass = new HeightPass(mock);
  heightPass.dispatch(encoded, bindings);
  const height = heightPass.getSnapshot();
  const normalPass = new NormalPass(mock);
  normalPass.dispatch({ height: normalHeightBindingFromHeightPass(height), options: {} });
  const shadowPass = new ShadowPass(mock);
  shadowPass.dispatch({ scene: encoded, bindings, ...shadowHeightBindingsFromHeightPass(height) });
  const lightingPass = new LightingPass(mock);
  lightingPass.dispatch({
    scene: encoded,
    bindings,
    materialId: lightingMaterialIdBindingFromHeightPass(height),
    normal: lightingNormalBindingFromNormalPass(normalPass.getSnapshot()),
    visibility: lightingVisibilityBindingFromShadowPass(shadowPass.getSnapshot()),
  });
  const lighting = lightingPass.getSnapshot();
  return {
    encoded,
    bindings,
    height,
    input: {
      color: presentationColorBindingFromLightingPass(lighting),
      objectId: presentationObjectIdBindingFromHeightPass(height),
      visibility: presentationVisibilityBindingFromShadowPass(shadowPass.getSnapshot()),
      context: new MockCanvasContext(100, 80),
      canvasFormat: "rgba8unorm",
    },
  };
}

function chain(scene: Scene = presentationScene(), dpr = 1) {
  return runChain(new MockComputeDevice(), scene, dpr);
}

function setup(limits: Partial<GpuPresentationLimitsLike> = {}) {
  const device = new MockPresentationDevice(limits);
  const pass = new PresentationPass(device);
  return { device, pass };
}

const TEXEL_BYTES = 100 * 80 * 4;
const COUNT_STORAGE = (entries: readonly GpuBindGroupLayoutEntryLike[]) =>
  entries.filter((e) => e.buffer?.type === "storage" || e.buffer?.type === "read-only-storage")
    .length;

// ---------------------------------------------------------------------------
// #29 shared CPU compositor semantics (the parity oracle for the WGSL)
// ---------------------------------------------------------------------------

describe("sanitizeCompositeOptions — CPU-compatible composite option sanitization", () => {
  it("uses the DOM-compositor defaults", () => {
    expect(DEFAULT_SHADOW_COLOR).toEqual([12, 16, 28]);
    expect(DEFAULT_SHADOW_ALPHA).toBe(0.3);
    expect(sanitizeCompositeOptions()).toEqual({
      shadowColor: [12, 16, 28],
      shadowAlpha: 0.3,
    });
  });

  it("rounds fractional bytes and clamps endpoints like the CPU compositor", () => {
    expect(sanitizeCompositeOptions({ shadowColor: [1.4, 1.5, 1.6] }).shadowColor).toEqual([1, 2, 2]);
    expect(sanitizeCompositeOptions({ shadowColor: [-5, 300, 12.49] }).shadowColor).toEqual([0, 255, 12]);
    // the documented byte contract clamps the second channel to 255 (v > 255)
    expect(sanitizeCompositeOptions({ shadowColor: [255.4, 255.5, -0.2] }).shadowColor).toEqual([255, 255, 0]);
  });

  it("handles non-finite shadow color channels exactly like the CPU compositor", () => {
    // NaN passes through clampByte (Math.round(NaN) = NaN); the GPU uniform
    // coerces it to 0 exactly like Uint8ClampedArray. Infinities clamp.
    const nan = sanitizeCompositeOptions({ shadowColor: [NaN, 0, 0] });
    expect(Number.isNaN(nan.shadowColor[0])).toBe(true);
    expect(sanitizeCompositeOptions({ shadowColor: [Infinity, -Infinity, 0] }).shadowColor).toEqual([255, 0, 0]);
  });

  it("falls back to the default alpha on NaN/infinities and clamps endpoints", () => {
    expect(sanitizeCompositeOptions({ shadowAlpha: NaN }).shadowAlpha).toBe(DEFAULT_SHADOW_ALPHA);
    expect(sanitizeCompositeOptions({ shadowAlpha: Infinity }).shadowAlpha).toBe(DEFAULT_SHADOW_ALPHA);
    expect(sanitizeCompositeOptions({ shadowAlpha: -Infinity }).shadowAlpha).toBe(DEFAULT_SHADOW_ALPHA);
    expect(sanitizeCompositeOptions({ shadowAlpha: -1 }).shadowAlpha).toBe(0);
    expect(sanitizeCompositeOptions({ shadowAlpha: 2 }).shadowAlpha).toBe(1);
    expect(sanitizeCompositeOptions({ shadowAlpha: 0.5 }).shadowAlpha).toBe(0.5);
    expect(sanitizeCompositeOptions({ shadowAlpha: 0 }).shadowAlpha).toBe(0);
    expect(sanitizeCompositeOptions({ shadowAlpha: 1 }).shadowAlpha).toBe(1);
  });

  it("encodes alpha with floor(alpha * 255 + 0.5) == Math.round", () => {
    expect(compositeShadowAlphaByte(0.3)).toBe(Math.round(0.3 * 255));
    expect(compositeShadowAlphaByte(0.5)).toBe(128); // Math.round(127.5)
    expect(compositeShadowAlphaByte(0)).toBe(0);
    expect(compositeShadowAlphaByte(1)).toBe(255);
    expect(compositeShadowAlphaByte(0.2549)).toBe(65);
  });

  it("computes the premultiplied shadow bytes in f32 arithmetic (parity oracle)", () => {
    // alpha 1: opaque shadow color, exact
    expect(compositeShadowPremultipliedBytes({ shadowColor: [12, 16, 28], shadowAlpha: 1 })).toEqual([12, 16, 28, 255]);
    // alpha 0: fully transparent
    expect(compositeShadowPremultipliedBytes({ shadowAlpha: 0 })).toEqual([0, 0, 0, 0]);
    // 255 * 128 / 255 = 128 exactly in f32
    expect(compositeShadowPremultipliedBytes({ shadowColor: [255, 255, 255], shadowAlpha: 0.5 })).toEqual([128, 128, 128, 128]);
    // default tint at the default alpha
    const [r, g, b, a] = compositeShadowPremultipliedBytes();
    expect([r, g, b, a]).toEqual([
      Math.round(Math.fround(Math.fround(12 * 77) / 255)),
      Math.round(Math.fround(Math.fround(16 * 77) / 255)),
      Math.round(Math.fround(Math.fround(28 * 77) / 255)),
      77,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Pipeline creation, target-format cache, command order
// ---------------------------------------------------------------------------

describe("PresentationPass — explicit shader/layout/render-pipeline creation and the target-format cache", () => {
  it("creates the shader module, bind-group layout, pipeline layout and render pipeline once and reuses them", () => {
    const { device, pass } = setup();
    const { input } = chain();
    pass.present(input);
    expect(device.shaderModules.filter((code) => code === PRESENTATION_PASS_WGSL)).toHaveLength(1);
    expect(device.bindGroupLayouts).toHaveLength(1);
    expect(device.pipelineLayouts).toHaveLength(1);
    expect(device.renderPipelines).toHaveLength(1);

    pass.present({ ...input, options: { shadowAlpha: 0.5 } });
    pass.present(input);
    expect(device.shaderModules.filter((code) => code === PRESENTATION_PASS_WGSL)).toHaveLength(1);
    expect(device.bindGroupLayouts).toHaveLength(1);
    expect(device.pipelineLayouts).toHaveLength(1);
    expect(device.renderPipelines).toHaveLength(1);
  });

  it("caches the render pipeline per canvas target format", () => {
    const { device, pass } = setup();
    const { input } = chain();
    pass.present({ ...input, canvasFormat: "rgba8unorm" });
    expect(pass.getSnapshot().canvasFormat).toBe("rgba8unorm");

    pass.present({ ...input, canvasFormat: "bgra8unorm" });
    expect(pass.getSnapshot().canvasFormat).toBe("bgra8unorm");
    expect(device.renderPipelines).toHaveLength(2);
    expect(device.renderPipelines[0].fragment.targets[0].format).toBe("rgba8unorm");
    expect(device.renderPipelines[1].fragment.targets[0].format).toBe("bgra8unorm");
    expect(device.shaderModules.filter((code) => code === PRESENTATION_PASS_WGSL)).toHaveLength(1);

    pass.present({ ...input, canvasFormat: "rgba8unorm" });
    expect(device.renderPipelines).toHaveLength(2); // the rgba8unorm pipeline is cached
  });

  it("uses an explicit pipeline layout (never layout: 'auto')", () => {
    const { device, pass } = setup();
    const { input } = chain();
    pass.present(input);
    const pipeline = device.renderPipelines[0];
    expect(pipeline.layout).toBe(device.pipelineLayouts[0].layout);
    expect(device.pipelineLayouts[0].bindGroupLayouts[0]).toBe(device.bindGroupLayouts[0].layout);
    expect(pipeline.fragment.entryPoint).toBe("fs_main");
    expect(pipeline.vertex.entryPoint).toBe("vs_main");
    expect(pipeline.primitive).toEqual({ topology: "triangle-list" });
  });

  it("pins the fragment-stage bind group layout entries with shader-derived minimum sizes", () => {
    const { device, pass } = setup();
    const { input } = chain();
    pass.present(input);
    const entries = device.bindGroupLayouts[0].entries;
    expect(entries).toHaveLength(4);
    for (const entry of entries) {
      expect(entry.visibility).toBe(FRAGMENT_STAGE_VISIBILITY);
    }
    expect(entries[0]).toMatchObject({
      binding: 0,
      buffer: { type: "uniform", hasDynamicOffset: false, minBindingSize: PRESENTATION_PARAMS_BYTE_LENGTH },
    });
    for (const [binding, type, min] of [
      [1, "read-only-storage", 4],
      [2, "read-only-storage", 4],
      [3, "read-only-storage", 4],
    ] as const) {
      expect(entries[binding]).toMatchObject({
        binding,
        buffer: { type, hasDynamicOffset: false, minBindingSize: min },
      });
    }
    // fragment storage budget: 3 read-only buffers (below the spec minimum 8)
    expect(COUNT_STORAGE(entries)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Direct bindings + provenance
// ---------------------------------------------------------------------------

describe("PresentationPass — exact color/objectId/visibility bindings and strict shared provenance", () => {
  it("binds the exact #28/#25/#27 buffers with explicit validated sizes", () => {
    const { device, pass } = setup();
    const { input } = chain();
    pass.present(input);
    const group = device.bindGroups[device.bindGroups.length - 1];
    expect(group.entries).toHaveLength(4);
    expect(group.entries[0].resource.buffer).toBe(device.created.at(-1)!.buffer);
    expect(group.entries[1].resource.buffer).toBe(input.color.buffer);
    expect(group.entries[2].resource.buffer).toBe(input.objectId.buffer);
    expect(group.entries[3].resource.buffer).toBe(input.visibility.buffer);
    expect(group.entries.map((entry) => entry.resource.size)).toEqual([
      PRESENTATION_PARAMS_BYTE_LENGTH,
      TEXEL_BYTES,
      TEXEL_BYTES,
      TEXEL_BYTES,
    ]);
  });

  it("rejects fields mixed across two HeightPass dispatches of the exact same scene", () => {
    const { device, pass } = setup();
    const scene = presentationScene();
    const encoded = encodeScene(scene, 1);
    const first = runChain(new MockComputeDevice(), scene, 1, encoded);
    const second = runChain(new MockComputeDevice(), scene, 1, encoded);
    expect(second.input.color.provenance).not.toBe(first.input.color.provenance);
    expect(() =>
      pass.present({ ...first.input, color: second.input.color }),
    ).toThrow(/mixed HeightPass provenance/);
    expect(() =>
      pass.present({ ...first.input, objectId: second.input.objectId }),
    ).toThrow(/mixed HeightPass provenance/);
    expect(() =>
      pass.present({ ...first.input, visibility: second.input.visibility }),
    ).toThrow(/mixed HeightPass provenance/);
    // rejected BEFORE any presentation device/context call
    expect(device.created).toHaveLength(0);
    expect(device.encoders).toHaveLength(0);
    expect((first.input.context as MockCanvasContext).configured).toHaveLength(0);
  });

  it("rejects a foreign provenance before any device/context call", () => {
    const { device, pass } = setup();
    const { input } = chain();
    // A hand-crafted provenance over an encoded scene whose #24 ABI header
    // does NOT match its own extent claims: real HeightPass provenance is
    // internally consistent (its width/height/dpr are read from the very
    // sceneBytes it carries), so this is detectable on the host.
    const other = encodeScene(createScene({ width: 90, height: 80, surfaces: [] }), 1);
    const foreign = Object.freeze({ sceneBytes: other.bytes, width: 100, height: 80, dpr: 1 });
    expect(() =>
      pass.present({
        ...input,
        color: { ...input.color, provenance: foreign },
        objectId: { ...input.objectId, provenance: foreign },
        visibility: { ...input.visibility, provenance: foreign },
      }),
    ).toThrow(/foreign HeightPass provenance/);
    expect(device.created).toHaveLength(0);
    expect((input.context as MockCanvasContext).configured).toHaveLength(0);
  });

  it("rejects a provenance whose extent does not match the fields", () => {
    const { device, pass } = setup();
    const { input } = chain();
    const mismatched = Object.freeze({ sceneBytes: input.color.provenance.sceneBytes, width: 99, height: 80, dpr: 1 });
    expect(() =>
      pass.present({
        ...input,
        color: { ...input.color, provenance: mismatched },
        objectId: { ...input.objectId, provenance: mismatched },
        visibility: { ...input.visibility, provenance: mismatched },
      }),
    ).toThrow(/HeightPass provenance extent/);
    expect(device.created).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Uniform packing
// ---------------------------------------------------------------------------

describe("PresentationPass — uniform byte layout and little-endian packing", () => {
  it("packs width/height/shadow bytes/alpha byte little-endian at the pinned offsets", () => {
    const { device, pass } = setup();
    const { input } = chain();
    pass.present({ ...input, options: { shadowColor: [12, 16, 28], shadowAlpha: 0.3 } });
    const write = device.writes[device.writes.length - 1];
    expect(write.bytes.byteLength).toBe(PRESENTATION_PARAMS_BYTE_LENGTH);
    const view = new DataView(write.bytes.buffer);
    expect(view.getUint32(0, true)).toBe(100);
    expect(view.getUint32(4, true)).toBe(80);
    expect(view.getUint32(8, true)).toBe(12);
    expect(view.getUint32(12, true)).toBe(16);
    expect(view.getUint32(16, true)).toBe(28);
    expect(view.getUint32(20, true)).toBe(77); // Math.round(0.3 * 255)
    expect(view.getUint32(24, true)).toBe(0);
    expect(view.getUint32(28, true)).toBe(0);
  });

  it("coerces a NaN shadow channel to byte 0 exactly like Uint8ClampedArray", () => {
    const { device, pass } = setup();
    const { input } = chain();
    pass.present({ ...input, options: { shadowColor: [NaN, 50, 200] } });
    const view = new DataView(device.writes[device.writes.length - 1].bytes.buffer);
    expect(view.getUint32(8, true)).toBe(0);
    expect(view.getUint32(12, true)).toBe(50);
    expect(view.getUint32(16, true)).toBe(200);
  });

  it("packs sanitized endpoints and fractional alpha in the uniform and reports them in the snapshot", () => {
    const { device, pass } = setup();
    const { input } = chain();
    pass.present({ ...input, options: { shadowAlpha: -0.5 } });
    expect(new DataView(device.writes.at(-1)!.bytes.buffer).getUint32(20, true)).toBe(0);
    expect(pass.getSnapshot().composite.shadowAlpha).toBe(0);

    pass.present({ ...input, options: { shadowAlpha: 2 } });
    expect(new DataView(device.writes.at(-1)!.bytes.buffer).getUint32(20, true)).toBe(255);
    expect(pass.getSnapshot().composite.shadowAlpha).toBe(1);

    pass.present({ ...input, options: { shadowAlpha: NaN } });
    expect(new DataView(device.writes.at(-1)!.bytes.buffer).getUint32(20, true)).toBe(77);
    expect(pass.getSnapshot().composite.shadowAlpha).toBe(DEFAULT_SHADOW_ALPHA);

    pass.present({ ...input, options: { shadowAlpha: 0.5 } });
    expect(new DataView(device.writes.at(-1)!.bytes.buffer).getUint32(20, true)).toBe(128);
    expect(pass.getSnapshot().composite.shadowAlpha).toBe(0.5);
  });

  it("keeps the packed uniform and the snapshot on the same sanitized values", () => {
    const { device, pass } = setup();
    const { input } = chain();
    pass.present({ ...input, options: { shadowColor: [1.5, 254.5, 0], shadowAlpha: 0.2549 } });
    const view = new DataView(device.writes.at(-1)!.bytes.buffer);
    const composite = pass.getSnapshot().composite;
    expect(view.getUint32(8, true)).toBe(composite.shadowColor[0]);
    expect(view.getUint32(12, true)).toBe(composite.shadowColor[1]);
    expect(view.getUint32(20, true)).toBe(compositeShadowAlphaByte(composite.shadowAlpha));
  });
});

// ---------------------------------------------------------------------------
// Command order, fullscreen draw, one submission
// ---------------------------------------------------------------------------

describe("PresentationPass — render-pass command order and one queue submission", () => {
  it("records clear -> setPipeline -> setBindGroup(0) -> draw(3) -> end -> finish -> submit", () => {
    const { device, pass } = setup();
    const { input } = chain();
    pass.present(input);
    const encoder = device.encoders[device.encoders.length - 1];
    expect(encoder.passes).toHaveLength(1);
    const render = encoder.passes[0];
    const desc = render.desc as { colorAttachments: readonly [{ view: unknown; clearValue: unknown; loadOp: string; storeOp: string }] };
    expect(desc.colorAttachments).toHaveLength(1);
    expect(desc.colorAttachments[0].loadOp).toBe("clear");
    expect(desc.colorAttachments[0].storeOp).toBe("store");
    expect(desc.colorAttachments[0].clearValue).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(render.calls.pipeline).toBe(device.renderPipelines[0].pipeline);
    expect(render.log).toEqual(["setPipeline", "setBindGroup(0)", "draw(3)", "end"]);
    expect(render.calls.draws).toEqual([3]);
    expect(render.calls.bindGroups[0].index).toBe(0);
    expect(encoder.finished).toBe(true);
    expect(device.submits).toHaveLength(1);
    expect(device.submits[0]).toHaveLength(1);
  });

  it("never retains a current texture/view across frames", () => {
    const { device, pass } = setup();
    const { input } = chain();
    const context = input.context as MockCanvasContext;
    pass.present({ ...input, context });
    pass.present({ ...input, context });
    // exactly one getCurrentTexture per present; no view is cached anywhere
    expect(context.textures).toHaveLength(2);
    expect(context.textures[0]).not.toBe(context.textures[1]);
    expect(device.encoders).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Context configuration
// ---------------------------------------------------------------------------

describe("PresentationPass — context configuration fields, reuse and debug-only COPY_SRC", () => {
  it("configures with the owning device, the resolved format, RENDER_ATTACHMENT, premultiplied alpha and srgb color space", () => {
    const { device, pass } = setup();
    const { input } = chain();
    const context = input.context as MockCanvasContext;
    pass.present({ ...input, context, canvasFormat: "bgra8unorm" });
    expect(context.configured).toHaveLength(1);
    const config = context.configured[0];
    expect(config.device).toBe(device);
    expect(config.format).toBe("bgra8unorm");
    expect(config.usage).toBe(GPU_USAGE_RENDER_ATTACHMENT);
    expect(config.alphaMode).toBe(PRESENTATION_ALPHA_MODE);
    expect(config.colorSpace).toBe(PRESENTATION_COLOR_SPACE);
    expect(pass.getSnapshot().canvasFormat).toBe("bgra8unorm");
    expect(pass.getSnapshot().alphaMode).toBe("premultiplied");
    expect(pass.getSnapshot().colorSpace).toBe("srgb");
  });

  it("reuses the configuration while device/format/debug usage are unchanged", () => {
    const { device, pass } = setup();
    const { input } = chain();
    const context = input.context as MockCanvasContext;
    pass.present({ ...input, context });
    pass.present({ ...input, context });
    pass.present({ ...input, context, options: { shadowAlpha: 0.1 } });
    expect(context.configured).toHaveLength(1);
    expect(pass.getSnapshot().configurationGeneration).toBe(1);
  });

  it("reconfigures when the context, canvas format or debug usage changes", () => {
    const { device, pass } = setup();
    const { input } = chain();
    const context = input.context as MockCanvasContext;
    pass.present({ ...input, context });
    pass.present({ ...input, context, canvasFormat: "bgra8unorm" });
    pass.present({ ...input, context, canvasFormat: "bgra8unorm", debug: true });
    expect(context.configured).toHaveLength(3);
    expect(pass.getSnapshot().configurationGeneration).toBe(3);
    expect(context.configured[1].format).toBe("bgra8unorm");
    expect(context.configured[2].usage).toBe(
      GPU_USAGE_RENDER_ATTACHMENT | GPU_TEXTURE_USAGE_COPY_SRC,
    );
    expect(pass.getSnapshot().debug).toBe(true);
  });

  it("never skips configure() for a different context that uses the same format", () => {
    const { device, pass } = setup();
    const { input } = chain();
    const first = input.context as MockCanvasContext;
    const second = new MockCanvasContext(100, 80);
    pass.present({ ...input, context: first });
    pass.present({ ...input, context: second });
    expect(first.configured).toHaveLength(1);
    expect(second.configured).toHaveLength(1);
    // the previous context is explicitly unconfigured on the switch
    expect(first.unconfigured).toBe(true);
    expect(second.unconfigured).toBe(false);
    expect(pass.getSnapshot().configurationGeneration).toBe(2);
    // switching back to the first context reconfigures it (never skipped)
    pass.present({ ...input, context: first });
    expect(first.configured).toHaveLength(2);
    expect(pass.getSnapshot().configurationGeneration).toBe(3);
  });

  it("adds COPY_SRC only in debug mode; the production default never exposes it", () => {
    const { device, pass } = setup();
    const { input } = chain();
    const context = input.context as MockCanvasContext;
    pass.present({ ...input, context });
    expect(context.configured[0].usage).toBe(GPU_USAGE_RENDER_ATTACHMENT);
    pass.present({ ...input, context, debug: true });
    expect(context.configured[1].usage).toBe(
      GPU_USAGE_RENDER_ATTACHMENT | GPU_TEXTURE_USAGE_COPY_SRC,
    );
  });

  it("rejects a non-8-bit canvas format before any device/context call", () => {
    const { device, pass } = setup();
    const { input } = chain();
    expect(() =>
      pass.present({ ...input, canvasFormat: "rgba16float" as never }),
    ).toThrow(/not an 8-bit RGBA\/BGRA format/);
    expect(device.created).toHaveLength(0);
    expect((input.context as MockCanvasContext).configured).toHaveLength(0);
  });

  it("rejects a stale backing store and accepts the resized one on the next present", () => {
    const { device, pass } = setup();
    const { input } = chain();
    const context = input.context as MockCanvasContext;
    context.canvas.width = 640;
    context.canvas.height = 360;
    expect(() => pass.present({ ...input, context })).toThrow(/canvas backing store 640x360/);
    expect(context.configured).toHaveLength(0);
    expect(device.encoders).toHaveLength(0);
    // backing-store resize invalidates the old current texture; the next
    // present validates the new size and acquires a fresh texture
    context.canvas.width = 100;
    context.canvas.height = 80;
    pass.present({ ...input, context });
    expect(context.configured).toHaveLength(1);
    expect(context.textures).toHaveLength(1);
    expect(context.textures[0].width).toBe(100);
    expect(context.textures[0].height).toBe(80);
  });
});

// ---------------------------------------------------------------------------
// Pre-device/context rejection paths
// ---------------------------------------------------------------------------

describe("PresentationPass — every pre-device/context rejection path", () => {
  it("rejects a non-positive or non-integer extent before any device call", () => {
    const { device, pass } = setup();
    const { input } = chain();
    expect(() =>
      pass.present({ ...input, color: { ...input.color, width: 0 } }),
    ).toThrow(/color binding width must be a positive integer/);
    expect(() =>
      pass.present({ ...input, visibility: { ...input.visibility, height: 1.5 } }),
    ).toThrow(/visibility binding height must be a positive integer/);
    expect(device.created).toHaveLength(0);
  });

  it("rejects a render texel count above u32 before any device call", () => {
    const { device, pass } = setup();
    const { input } = chain();
    // 60000000 x 80 = 4.8e9 texels > u32 max (4294967295): the in-shader
    // u32 index product would overflow, so the host must reject first.
    const wide = { ...input, color: { ...input.color, width: 60000000 }, objectId: { ...input.objectId, width: 60000000 }, visibility: { ...input.visibility, width: 60000000 } };
    expect(() => pass.present(wide)).toThrow(/render texel count 60000000x80 exceeds u32/);
    expect(device.created).toHaveLength(0);
  });

  it("rejects mixed extents and mixed DPR", () => {
    const { device, pass } = setup();
    const { input } = chain();
    expect(() =>
      pass.present({ ...input, objectId: { ...input.objectId, width: 99 } }),
    ).toThrow(/mixed presentation extents/);
    expect(() =>
      pass.present({ ...input, visibility: { ...input.visibility, dpr: 2 } }),
    ).toThrow(/mixed presentation DPR/);
    expect(device.created).toHaveLength(0);
  });

  it("rejects wrong formats, channels, byte lengths, missing STORAGE and undersized buffers", () => {
    const { device, pass } = setup();
    const { input } = chain();
    const field = (binding: PresentationInputBinding): PresentationInputBinding => binding;
    expect(() =>
      pass.present({ ...input, color: field({ ...input.color, format: "u32" }) }),
    ).toThrow(/color binding format .* != rgba8/);
    expect(() =>
      pass.present({ ...input, objectId: field({ ...input.objectId, format: "f32" }) }),
    ).toThrow(/objectId binding format .* != u32/);
    expect(() =>
      pass.present({ ...input, visibility: field({ ...input.visibility, format: "u32" }) }),
    ).toThrow(/visibility binding format .* != f32/);
    expect(() =>
      pass.present({ ...input, color: field({ ...input.color, channels: 1 }) }),
    ).toThrow(/color binding channels 1 != 4/);
    expect(() =>
      pass.present({ ...input, objectId: field({ ...input.objectId, channels: 4 }) }),
    ).toThrow(/objectId binding channels 4 != 1/);
    expect(() =>
      pass.present({ ...input, color: field({ ...input.color, byteLength: TEXEL_BYTES - 4 }) }),
    ).toThrow(/color binding byteLength/);
    expect(() =>
      pass.present({ ...input, visibility: field({ ...input.visibility, usage: 0x8 }) }),
    ).toThrow(/visibility binding usage 0x8 lacks STORAGE/);
    expect(() =>
      pass.present({
        ...input,
        visibility: field({ ...input.visibility, buffer: { ...input.visibility.buffer, size: 64 } }),
      }),
    ).toThrow(/visibility buffer size 64 < required/);
    expect(device.created).toHaveLength(0);
  });

  it("rejects binding ranges beyond maxStorageBufferBindingSize", () => {
    const { device, pass } = setup({ maxStorageBufferBindingSize: 4096, maxBufferSize: 4096 });
    const { input } = chain(); // 32000-byte fields
    let message = "";
    try {
      pass.present(input);
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("maxStorageBufferBindingSize 4096");
    expect(message).toContain("color field binding range of 32000 bytes");
    expect(device.created).toHaveLength(0);
  });

  it("rejects a uniform allocation beyond maxUniformBufferBindingSize / maxBufferSize", () => {
    const { device, pass } = setup({ maxUniformBufferBindingSize: 8, maxBufferSize: 1 << 20 });
    const { input } = chain();
    let message = "";
    try {
      pass.present(input);
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("maxUniformBufferBindingSize 8");
    expect(device.created).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Device loss, disposal, snapshot
// ---------------------------------------------------------------------------

describe("PresentationPass — device-loss fail-closed behavior, disposal and owned allocation cleanup", () => {
  it("throws before the first present and after dispose", () => {
    const { device, pass } = setup();
    expect(() => pass.getSnapshot()).toThrow(/no present/);
    const { input } = chain();
    pass.present(input);
    expect(pass.getSnapshot().workSubmitted).toBe(1);
    pass.dispose();
    expect(() => pass.present(input)).toThrow(/disposed/);
    expect(() => pass.getSnapshot()).toThrow(/disposed/);
    pass.dispose(); // idempotent
  });

  it("fails closed once the device is lost: no configure, no submission, no snapshot", async () => {
    const { device, pass } = setup();
    const { input } = chain();
    device.triggerLoss();
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 0));
    const context = input.context as MockCanvasContext;
    expect(() => pass.present({ ...input, context })).toThrow(/device is lost/);
    expect(context.configured).toHaveLength(0);
    expect(device.encoders).toHaveLength(0);
    expect(device.submits).toHaveLength(0);
    expect(() => pass.getSnapshot()).toThrow(/device is lost/);
    // an unrelated pass on a healthy device is unaffected
    const { pass: healthy } = setup();
    healthy.present(chain().input);
    expect(healthy.getSnapshot().workSubmitted).toBe(1);
  });

  it("unconfigures the context and destroys only the owned uniform on dispose", () => {
    const { device, pass } = setup();
    const { input } = chain();
    const context = input.context as MockCanvasContext;
    pass.present({ ...input, context });
    const owned = device.created.map((c) => c.buffer);
    const foreign = [input.color.buffer, input.objectId.buffer, input.visibility.buffer] as MockBuffer[];
    pass.dispose();
    expect(context.unconfigured).toBe(true);
    for (const buffer of owned) {
      expect(buffer.destroyed).toBe(true);
    }
    for (const buffer of foreign) {
      expect(buffer.destroyed).toBe(false);
    }
  });

  it("does not touch a stale context on dispose after device loss", async () => {
    const { device, pass } = setup();
    const { input } = chain();
    const context = input.context as MockCanvasContext;
    pass.present({ ...input, context });
    device.triggerLoss();
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 0));
    pass.dispose();
    expect(context.unconfigured).toBe(false); // never touched after loss
  });

  it("reports the snapshot fields and keeps them stable across presents", () => {
    const { device, pass } = setup();
    const { input } = chain();
    pass.present({ ...input, options: { shadowColor: [200, 100, 50], shadowAlpha: 0.25 } });
    const snapshot = pass.getSnapshot();
    expect(snapshot.width).toBe(100);
    expect(snapshot.height).toBe(80);
    expect(snapshot.dpr).toBe(1);
    expect(snapshot.canvasFormat).toBe("rgba8unorm");
    expect(snapshot.composite).toEqual({
      shadowColor: [200, 100, 50],
      shadowAlpha: 0.25,
    });
    expect(snapshot.workSubmitted).toBe(1);
    expect(snapshot.configurationGeneration).toBe(1);
    expect(typeof snapshot.hostEncodeMs).toBe("number");
    expect(snapshot.hostEncodeMs).toBeGreaterThanOrEqual(0);
    const uniformCreated = device.created.filter((c) => c.desc.label === "ukibori-uniform");
    expect(uniformCreated).toHaveLength(1);
    expect(uniformCreated[0].desc.usage).toBe(0x40 | 0x8); // UNIFORM | COPY_DST
    expect(pass.present(input).configured).toBe(false);
  });

  it("reuses the uniform allocation across presents and reports allocation stats", () => {
    const { device, pass } = setup();
    const { input } = chain();
    const first = pass.present(input);
    expect(first.newAllocations).toBe(1);
    expect(first.allocationCount).toBe(1);
    const created = device.created.length;
    const second = pass.present(input);
    expect(second.newAllocations).toBe(0);
    expect(device.created.length).toBe(created);
  });

  it("never maps or reads back during normal presentation (no readback surface)", () => {
    const { device, pass } = setup();
    const { input } = chain();
    pass.present(input);
    const queue = device.queue as unknown as Record<string, unknown>;
    expect(queue.mapAsync).toBeUndefined();
    expect(queue.copyBufferToBuffer).toBeUndefined();
    for (const { buffer } of device.created) {
      const b = buffer as unknown as Record<string, unknown>;
      expect(b.mapAsync).toBeUndefined();
      expect(b.getMappedRange).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// WGSL contract assertions (string-level pins; numeric parity is the
// real-GPU browser test, never a mock claim)
// ---------------------------------------------------------------------------

describe("PresentationPass shader — fixed composition semantics in WGSL", () => {
  it("declares the exact group-0 bindings with the documented meanings", () => {
    expect(PRESENTATION_PASS_WGSL).toContain("@group(0) @binding(0) var<uniform> params: PresentationParams;");
    expect(PRESENTATION_PASS_WGSL).toContain("@group(0) @binding(1) var<storage, read> colorField: array<u32>;");
    expect(PRESENTATION_PASS_WGSL).toContain("@group(0) @binding(2) var<storage, read> objectId: array<u32>;");
    expect(PRESENTATION_PASS_WGSL).toContain("@group(0) @binding(3) var<storage, read> visibilityField: array<f32>;");
  });

  it("pins the params struct offsets and the 32-byte uniform length", () => {
    expect(PRESENTATION_PASS_WGSL).toContain("width: u32,            //  0");
    expect(PRESENTATION_PASS_WGSL).toContain("height: u32,           //  4");
    expect(PRESENTATION_PASS_WGSL).toContain("shadowR: u32,          //  8");
    expect(PRESENTATION_PASS_WGSL).toContain("shadowG: u32,          // 12");
    expect(PRESENTATION_PASS_WGSL).toContain("shadowB: u32,          // 16");
    expect(PRESENTATION_PASS_WGSL).toContain("shadowAlphaByte: u32,  // 20");
    expect(PRESENTATION_PARAMS_BYTE_LENGTH).toBe(32);
  });

  it("extracts the packed RGBA8 bytes in R,G,B order with alpha 255 and NO_OWNER handling", () => {
    expect(PRESENTATION_PASS_WGSL).toContain("let packed = colorField[index];");
    expect(PRESENTATION_PASS_WGSL).toContain("let r = f32(packed & 0xffu) * UNORM_SCALE;");
    expect(PRESENTATION_PASS_WGSL).toContain("let g = f32((packed >> 8u) & 0xffu) * UNORM_SCALE;");
    expect(PRESENTATION_PASS_WGSL).toContain("let b = f32((packed >> 16u) & 0xffu) * UNORM_SCALE;");
    expect(PRESENTATION_PASS_WGSL).toContain("return vec4<f32>(r, g, b, 1.0);");
    expect(PRESENTATION_PASS_WGSL).toContain("let owner = objectId[index];");
    expect(PRESENTATION_PASS_WGSL).toContain("if (owner != NO_OWNER) {");
    expect(PRESENTATION_PASS_WGSL).toContain("const NO_OWNER: u32 = 0xffffffffu;");
  });

  it("uses the 0.5 visibility threshold and emits transparent black for the lit base plane", () => {
    expect(PRESENTATION_PASS_WGSL).toContain("let vis = visibilityField[index];");
    expect(PRESENTATION_PASS_WGSL).toContain("if (vis >= 0.5) {");
    expect(PRESENTATION_PASS_WGSL).toContain("return vec4<f32>(0.0);");
  });

  it("premultiplies the translucent shadow output for the premultiplied canvas", () => {
    expect(PRESENTATION_PASS_WGSL).toContain("let alpha = f32(params.shadowAlphaByte) * UNORM_SCALE;");
    expect(PRESENTATION_PASS_WGSL).toContain("let sr = f32(params.shadowR) * f32(params.shadowAlphaByte) / 255.0 * UNORM_SCALE;");
    expect(PRESENTATION_PASS_WGSL).toContain("let sg = f32(params.shadowG) * f32(params.shadowAlphaByte) / 255.0 * UNORM_SCALE;");
    expect(PRESENTATION_PASS_WGSL).toContain("let sb = f32(params.shadowB) * f32(params.shadowAlphaByte) / 255.0 * UNORM_SCALE;");
    expect(PRESENTATION_PASS_WGSL).toContain("return vec4<f32>(sr, sg, sb, alpha);");
  });

  it("derives texel coordinates from @builtin(position) with no y flip and guards the extent", () => {
    expect(PRESENTATION_PASS_WGSL).toContain("fn fs_main(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {");
    expect(PRESENTATION_PASS_WGSL).toContain("let x = u32(pos.x);");
    expect(PRESENTATION_PASS_WGSL).toContain("let y = u32(pos.y);");
    expect(PRESENTATION_PASS_WGSL).toContain("if (x >= params.width || y >= params.height) {");
    expect(PRESENTATION_PASS_WGSL).toContain("let index = y * params.width + x;");
    expect(PRESENTATION_PASS_WGSL).toContain("no vertical flip");
    expect(PRESENTATION_PASS_WGSL).toContain("no second gamma transform");
  });

  it("draws one fullscreen triangle from the vertex stage", () => {
    expect(PRESENTATION_PASS_WGSL).toContain("fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {");
    expect(PRESENTATION_PASS_WGSL).toContain("vec2<f32>(-1.0, -1.0)");
    expect(PRESENTATION_PASS_WGSL).toContain("vec2<f32>(3.0, -1.0)");
    expect(PRESENTATION_PASS_WGSL).toContain("vec2<f32>(-1.0, 3.0)");
  });
});

// ---------------------------------------------------------------------------
// Production modules contain no host readback / Canvas2D staging path
// ---------------------------------------------------------------------------

describe("PresentationPass production modules — no CPU staging or readback path", () => {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const productionSources = [
    "src/gpu/composite.ts",
    "src/gpu/presentation-pass-wgsl.ts",
    "src/gpu/presentation-pass.ts",
    "src/gpu/pipeline.ts",
  ].map((file) => readFileSync(resolve(packageRoot, file), "utf8"));

  for (const forbidden of [
    "mapAsync",
    "getMappedRange",
    "copyBufferToBuffer",
    "copyTextureToBuffer",
    "putImageData",
    "ImageData",
    "getContext",
    "createImageBitmap",
  ]) {
    it(`contains no ${forbidden} in any production module`, () => {
      for (const source of productionSources) {
        expect(source).not.toContain(forbidden);
      }
    });
  }
});

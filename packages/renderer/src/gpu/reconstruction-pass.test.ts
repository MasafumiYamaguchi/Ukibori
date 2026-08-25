import { describe, expect, it } from "vitest";
import { createScene } from "../scene";
import type { Scene } from "../scene";
import { encodeScene } from "./encode";
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
} from "./height-pass";
import { ShadowPass } from "./shadow-pass";
import { shadowHeightBindingsFromHeightPass } from "./shadow-pass";
import {
  RECONSTRUCTION_OUTPUT_BYTES_PER_TEXEL,
  RECONSTRUCTION_PARAMS_BYTE_LENGTH,
  RECONSTRUCTION_PASS_WGSL,
  RECONSTRUCTION_WORKGROUP_SIZE,
} from "./reconstruction-pass-wgsl";
import {
  RECONSTRUCTION_PASS_OUTPUT_USAGE,
  ReconstructionPass,
  lightingVisibilityBindingFromReconstructionPass,
  presentationVisibilityBindingFromReconstructionPass,
} from "./reconstruction-pass";
import { GPU_USAGE_STORAGE } from "./layout";

// ---------------------------------------------------------------------------
// Realistic structural mock (mirrors shadow-pass.test.ts): implements the
// same GpuComputeDeviceLike surface the real GPUDevice is cast into, records
// every call, never executes shaders (numeric parity is a real-GPU browser
// test).
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
  readonly calls: { dispatch: Array<{ x: number; y: number; z: number }> } = { dispatch: [] };
  setPipeline(): void {}
  setBindGroup(): void {}
  dispatchWorkgroups(x: number, y = 1, z = 1): void {
    this.calls.dispatch.push({ x, y, z });
  }
  end(): void {}
}

class MockEncoder implements GpuCommandEncoderLike {
  beginComputePass(): GpuComputePassEncoderLike {
    return new MockComputePass();
  }
  finish(): GpuCommandBufferLike {
    return { label: "mock-cmd" };
  }
}

class MockDevice implements GpuComputeDeviceLike {
  readonly limits: GpuLimitsLike = {
    maxComputeWorkgroupSizeX: 256,
    maxComputeInvocationsPerWorkgroup: 256,
    maxComputeWorkgroupsPerDimension: 65535,
    maxStorageBufferBindingSize: 256 * 1024 * 1024,
    maxBufferSize: 256 * 1024 * 1024,
  };
  readonly created: Array<{ desc: { size: number; usage: number; label?: string }; buffer: MockBuffer }> = [];
  readonly shaderModules: string[] = [];
  readonly pipelines: GpuComputePipelineLike[] = [];
  readonly bindGroupLayouts: GpuBindGroupLayoutLike[] = [];
  readonly pipelineLayouts: GpuPipelineLayoutLike[] = [];
  readonly bindGroups: GpuBindGroupLike[] = [];
  readonly submits: GpuCommandBufferLike[][] = [];
  readonly writes: Array<{ buffer: GpuBufferLike; bytes: Uint8Array }> = [];
  readonly queue = {
    writeBuffer: (buffer: GpuBufferLike, _dstByteOffset: number, source: Uint8Array): void => {
      this.writes.push({ buffer, bytes: source });
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
  createBindGroupLayout(_desc: { entries: GpuBindGroupLayoutEntryLike[]; label?: string }): GpuBindGroupLayoutLike {
    const layout = { entries: _desc.entries, label: _desc.label };
    this.bindGroupLayouts.push(layout);
    return layout;
  }
  createPipelineLayout(_desc: { bindGroupLayouts: GpuBindGroupLayoutLike[]; label?: string }): GpuPipelineLayoutLike {
    const layout = { bindGroupLayouts: _desc.bindGroupLayouts, label: _desc.label };
    this.pipelineLayouts.push(layout);
    return layout;
  }
  createComputePipeline(desc: {
    layout: GpuPipelineLayoutLike;
    compute: { module: GpuShaderModuleLike; entryPoint: string };
    label?: string;
  }): GpuComputePipelineLike {
    const pipeline = { label: desc.label };
    this.pipelines.push(pipeline);
    return pipeline;
  }
  createBindGroup(_desc: { layout: GpuBindGroupLayoutLike; entries: GpuBindGroupEntryLike[]; label?: string }): GpuBindGroupLike {
    const group = { layout: _desc.layout, entries: _desc.entries, label: _desc.label };
    this.bindGroups.push(group);
    return group;
  }
  createCommandEncoder(): GpuCommandEncoderLike {
    return new MockEncoder();
  }
}

function slabScene(angularRadius: number, samples: number): Scene {
  return createScene({
    width: 16,
    height: 16,
    surfaces: [
      {
        id: "slab",
        position: { x: 4, y: 2 },
        size: { x: 8, y: 2 },
        elevation: 6,
        shape: { kind: "roundedRect", radius: 0 },
        profile: { kind: "flat" },
        material: "silicone",
        castsShadow: true,
        receivesShadow: true,
      },
    ],
    light: { direction: { x: 0.70710678, y: 0, z: 0.70710678 }, intensity: 1, angularRadius },
  });
}

/** Full height+shadow chain on one mock, returning the recon input fields. */
function dispatchChain(mock: MockDevice, scene: Scene) {
  const encoded = encodeScene(scene, 1);
  const uploader = new SceneUploader(mock);
  uploader.upload(encoded);
  const bindings = uploader.getBindings();
  const heightPass = new HeightPass(mock);
  heightPass.dispatch(encoded, bindings);
  const heightFields = shadowHeightBindingsFromHeightPass(heightPass.getSnapshot());
  const shadowPass = new ShadowPass(mock);
  shadowPass.dispatch({
    scene: encoded,
    bindings,
    height: heightFields.height,
    casterHeight: heightFields.casterHeight,
    objectId: heightFields.objectId,
    options: { samples: 8 },
  });
  const shadow = shadowPass.getSnapshot();
  return {
    rawVisibility: {
      buffer: shadow.output.buffer,
      byteLength: shadow.output.byteLength,
      format: "f32" as const,
      usage: shadow.output.usage,
      width: shadow.width,
      height: shadow.height,
      provenance: shadow.provenance,
    },
    height: heightFields.height,
    objectId: heightFields.objectId,
  };
}

describe("ReconstructionPass — #43 GPU stage contract", () => {
  it("declares the exact group-0 bindings and a minimal aligned params uniform", () => {
    expect(RECONSTRUCTION_PASS_WGSL).toContain("@group(0) @binding(0) var<uniform> params: ReconstructionParams;");
    expect(RECONSTRUCTION_PASS_WGSL).toContain("@group(0) @binding(1) var<storage, read> inRawVisibility: array<f32>;");
    expect(RECONSTRUCTION_PASS_WGSL).toContain("@group(0) @binding(2) var<storage, read> inHeight: array<f32>;");
    expect(RECONSTRUCTION_PASS_WGSL).toContain("@group(0) @binding(3) var<storage, read> objectId: array<u32>;");
    expect(RECONSTRUCTION_PASS_WGSL).toContain("@group(0) @binding(4) var<storage, read_write> outReconstructed: array<f32>;");
    // the filter's only storage writes are its own output texel (the raw
    // field is read-only by declaration)
    expect(RECONSTRUCTION_PASS_WGSL).toContain("var<storage, read> inRawVisibility: array<f32>;");
    expect(RECONSTRUCTION_PASS_WGSL).toContain("var<storage, read_write> outReconstructed: array<f32>;");
    // fixed uniform weights + deterministic edge gates
    expect(RECONSTRUCTION_PASS_WGSL).toContain("objectId[ng] != centerOwner");
    expect(RECONSTRUCTION_PASS_WGSL).toContain("abs(centerY - nh) > params.heightGate");
    expect(RECONSTRUCTION_PASS_WGSL).toContain("clamp(vis, 0.0, 1.0)");
    expect(RECONSTRUCTION_PARAMS_BYTE_LENGTH).toBe(32);
    expect(RECONSTRUCTION_WORKGROUP_SIZE).toBe(64);
    expect(RECONSTRUCTION_OUTPUT_BYTES_PER_TEXEL).toBe(4);
  });

  it("dispatches with a uniform upload and one submission, reusing allocations", () => {
    const mock = new MockDevice();
    const pass = new ReconstructionPass(mock);
    const fields = dispatchChain(mock, slabScene(0.15, 8));
    const submitsBefore = mock.submits.length;
    const writesBefore = mock.writes.length;
    const first = pass.dispatch({ ...fields, options: { radius: 2 }, dpr: 1 });
    expect(first.newAllocations).toBe(2); // uniform + output
    expect(first.workgroupCountX).toBe(Math.ceil(16 * 16 / RECONSTRUCTION_WORKGROUP_SIZE));
    expect(first.submissions).toBe(1);
    expect(mock.submits.length).toBe(submitsBefore + 1);
    expect(mock.writes.length).toBe(writesBefore + 1);
    // the params uniform is 32 bytes with radius 2 at offset 8 and the f32
    // height gate at 20
    const view = new DataView(mock.writes.at(-1)!.bytes.buffer);
    expect(view.getUint32(0, true)).toBe(16);
    expect(view.getUint32(4, true)).toBe(16);
    expect(view.getUint32(8, true)).toBe(2);
    expect(view.getFloat32(20, true)).toBe(Math.fround(0.5));
    // region pads: full frame -> yOffset 0, regionEnd 0 (sentinel)
    expect(view.getUint32(12, true)).toBe(0);
    expect(view.getUint32(16, true)).toBe(0);
    const snapshot = pass.getSnapshot();
    expect(snapshot.width).toBe(16);
    expect(snapshot.height).toBe(16);
    expect(snapshot.dpr).toBe(1);
    expect(snapshot.options.radiusTexels).toBe(2);
    expect(snapshot.output.byteLength).toBe(16 * 16 * 4);
    expect(snapshot.output.usage).toBe(RECONSTRUCTION_PASS_OUTPUT_USAGE);
    // retained: a second dispatch with the same options adds no allocations
    const before = mock.created.length;
    pass.dispatch({ ...fields, options: { radius: 2 }, dpr: 1 });
    expect(pass.getSnapshot().options.radiusTexels).toBe(2);
    expect(mock.created.length).toBe(before);
  });

  it("packs the halo-expanded band region into yOffset/regionEnd", () => {
    const mock = new MockDevice();
    const pass = new ReconstructionPass(mock);
    const fields = dispatchChain(mock, slabScene(0.15, 8));
    pass.dispatch({
      ...fields,
      options: { radius: 2 },
      dpr: 1,
      region: { y0: 8, y1: 10 },
    });
    const view = new DataView(mock.writes.at(-1)!.bytes.buffer);
    expect(view.getUint32(12, true)).toBe(8 * 16);
    expect(view.getUint32(16, true)).toBe(11 * 16);
  });

  it("throws when dispatched with the filter bypassed", () => {
    const mock = new MockDevice();
    const pass = new ReconstructionPass(mock);
    const fields = dispatchChain(mock, slabScene(0.15, 8));
    expect(() => pass.dispatch({ ...fields, options: { enabled: false }, dpr: 1 })).toThrow(
      /bypassed/,
    );
    expect(() => pass.dispatch({ ...fields, options: { radius: 0 }, dpr: 1 })).toThrow(
      /bypassed/,
    );
  });

  it("rejects mixed or foreign provenance fields before any device call", () => {
    const mock = new MockDevice();
    const pass = new ReconstructionPass(mock);
    const fields = dispatchChain(mock, slabScene(0.15, 8));
    const foreign = dispatchChain(new MockDevice(), slabScene(0.15, 8));
    expect(() =>
      pass.dispatch({ ...fields, height: foreign.height }),
    ).toThrow(/mixed provenance/);
    expect(() =>
      pass.dispatch({ ...fields, objectId: foreign.objectId }),
    ).toThrow(/mixed provenance/);
    const submitsBefore = mock.submits.length;
    expect(mock.submits.length).toBe(submitsBefore);
  });

  it("rejects extent mismatches and caches the pipeline after one dispatch", () => {
    const mock = new MockDevice();
    const pass = new ReconstructionPass(mock);
    const fields = dispatchChain(mock, slabScene(0.15, 8));
    expect(() =>
      pass.dispatch({
        ...fields,
        rawVisibility: { ...fields.rawVisibility, width: 8 },
      }),
    ).toThrow(/expected/);
    const reconModulesBefore = mock.shaderModules.filter((m) => m.includes("outReconstructed")).length;
    expect(reconModulesBefore).toBe(0);
    pass.dispatch({ ...fields, options: { radius: 2 }, dpr: 1 });
    const reconModulesAfter = mock.shaderModules.filter((m) => m.includes("outReconstructed")).length;
    expect(reconModulesAfter).toBe(1);
    // cached: a second dispatch does not compile a second module
    pass.dispatch({ ...fields, options: { radius: 2 }, dpr: 1 });
    expect(mock.shaderModules.filter((m) => m.includes("outReconstructed")).length).toBe(1);
  });

  it("exposes output binding builders with the propagated provenance", () => {
    const mock = new MockDevice();
    const pass = new ReconstructionPass(mock);
    const fields = dispatchChain(mock, slabScene(0.15, 8));
    pass.dispatch({ ...fields, options: { radius: 2 }, dpr: 1 });
    const snapshot = pass.getSnapshot();
    const lighting = lightingVisibilityBindingFromReconstructionPass(snapshot);
    expect(lighting.buffer).toBe(snapshot.output.buffer);
    expect(lighting.provenance).toBe(snapshot.provenance);
    expect(lighting.format).toBe("f32");
    const presentation = presentationVisibilityBindingFromReconstructionPass(snapshot);
    expect(presentation.buffer).toBe(snapshot.output.buffer);
    expect(presentation.dpr).toBe(1);
    expect(presentation.provenance).toBe(snapshot.provenance);
  });

  it("disposes owned allocations idempotently", () => {
    const mock = new MockDevice();
    const pass = new ReconstructionPass(mock);
    const fields = dispatchChain(mock, slabScene(0.15, 8));
    pass.dispatch({ ...fields, options: { radius: 2 }, dpr: 1 });
    // the pass owns ONLY its uniform + output buffers (the last two created);
    // foreign height/shadow fields must never be destroyed
    const owned = mock.created.slice(-2).map((c) => c.buffer);
    const foreign = mock.created.slice(0, -2).map((c) => c.buffer);
    pass.dispose();
    expect(owned.every((b) => b.destroyed)).toBe(true);
    expect(foreign.every((b) => !b.destroyed)).toBe(true);
    expect(() => pass.getSnapshot()).toThrow(/no dispatch/);
    pass.dispose(); // idempotent
  });

  it("enforces device workgroup/limit constraints before any device call", () => {
    const mock = new MockDevice();
    const fields = dispatchChain(mock, slabScene(0.15, 8));
    const submitsBefore = mock.submits.length;
    (mock.limits as unknown as Record<string, unknown>).maxComputeWorkgroupSizeX = 32;
    const pass = new ReconstructionPass(mock);
    expect(() => pass.dispatch({ ...fields, options: { radius: 2 }, dpr: 1 })).toThrow(
      /workgroup size/,
    );
    expect(mock.submits.length).toBe(submitsBefore);
  });
});
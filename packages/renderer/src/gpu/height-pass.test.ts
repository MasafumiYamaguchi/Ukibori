import { describe, expect, it } from "vitest";
import { createScene } from "../scene";
import type { Scene } from "../scene";
import { encodeScene } from "./encode";
import { HEADER_SIZE, SURFACE_STRIDE } from "./layout";
import { SceneUploader } from "./uploader";
import type { GpuBufferLike, SceneBindings } from "./uploader";
import {
  COMPUTE_STAGE_VISIBILITY,
  HEIGHT_PASS_OUTPUT_USAGE,
  HeightPass,
} from "./height-pass";
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
import {
  COMPOSE_CASTER_HEIGHT_WGSL,
  COMPOSE_COVERAGE_WGSL,
  COMPOSE_HEIGHT_WGSL,
  COMPOSE_MATERIAL_ID_WGSL,
  COMPOSE_OBJECT_ID_WGSL,
  HEIGHT_PASS_PARAMS_BYTE_LENGTH,
  MASK_META_FULL_SENTINEL,
  MASK_META_STRIDE,
  MASK_SDF_WGSL,
  WORKGROUP_SIZE,
} from "./height-pass-wgsl";
import { WGSL_LAYOUT } from "./wgsl";
import { computeMaskWorkspaceLayout } from "./height-pass";

// ---------------------------------------------------------------------------
// u32-bounded host arithmetic (finding: values packed into WGSL u32 must be
// checked before any device call)
// ---------------------------------------------------------------------------

describe("computeMaskWorkspaceLayout  Eu32-bounded derived metadata", () => {
  it("computes cumulative workspace byte offsets for valid cell counts", () => {
    // 4x4 padded cells (16 cells) then 5x5 padded cells (25 cells)
    const layout = computeMaskWorkspaceLayout([16, 25]);
    expect(layout.offsets).toEqual([0, 64]); // 16 * 4 = 64 bytes
    expect(layout.workspaceBytes).toBe(164);
    expect(layout.workspaceBytes / 4).toBe(41); // == totalMaskCells
  });

  it("rejects per-mask padded cell counts above u32", () => {
    // (65537 + 2)^2 = 65539^2 > u32: the cell count itself overflows u32
    expect(() => computeMaskWorkspaceLayout([65539 * 65539])).toThrow(
      /mask\[0\] padded cell count .* exceeds u32 \(4294967295\)/,
    );
  });

  it("rejects cumulative workspace offsets above u32", () => {
    // two 6e8-cell masks: each costs 2.4e9 bytes; the second mask pushes
    // the cumulative total to 4.8e9, above u32 max (4294967295)
    expect(() => computeMaskWorkspaceLayout([6e8, 6e8])).toThrow(
      /mask\[1\] workspace byte offset 4800000000 exceeds u32 \(4294967295\)/,
    );
  });

  it("rejects non-safe-integer and negative cell counts", () => {
    expect(() => computeMaskWorkspaceLayout([Number.MAX_SAFE_INTEGER])).toThrow(/exceeds u32/);
    expect(() => computeMaskWorkspaceLayout([-4])).toThrow(/exceeds u32/);
  });
});

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
  readonly passDescriptors: Array<{ timestampWrites?: unknown }> = [];
  finished = false;
  beginComputePass(desc?: { readonly timestampWrites?: unknown }): GpuComputePassEncoderLike {
    const pass = new MockComputePass();
    this.passes.push(pass);
    this.passDescriptors.push({ timestampWrites: desc?.timestampWrites });
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

function maskScene(): Scene {
  return createScene({
    width: 20,
    height: 20,
    surfaces: [
      {
        id: "m",
        position: { x: 0, y: 0 },
        size: { x: 10, y: 10 },
        elevation: 0,
        shape: {
          kind: "mask",
          mask: { width: 2, height: 2, alpha: new Uint8Array([0, 128, 255, 64]) },
        },
        profile: { kind: "flat" },
        material: "silicone",
        castsShadow: false,
        receivesShadow: false,
      },
    ],
  });
}

function wideScene(): Scene {
  return createScene({
    width: 300,
    height: 200,
    surfaces: [
      {
        id: "w",
        position: { x: 0, y: 0 },
        size: { x: 10, y: 10 },
        elevation: 1,
        shape: { kind: "roundedRect", radius: 1 },
        profile: { kind: "flat" },
        material: "silicone",
        castsShadow: false,
        receivesShadow: false,
      },
    ],
  });
}

function uploadAndDispatch(
  mock: MockDevice,
  uploader: SceneUploader,
  pass: HeightPass,
  scene: Scene,
  dpr = 1,
) {
  const encoded = encodeScene(scene, dpr);
  uploader.upload(encoded);
  const bindings = uploader.getBindings();
  const stats = pass.dispatch(encoded, bindings);
  return { encoded, bindings, stats };
}

function setup() {
  const mock = new MockDevice();
  const uploader = new SceneUploader(mock);
  const pass = new HeightPass(mock);
  return { mock, uploader, pass };
}

const COMPOSE_MODULES = [
  COMPOSE_HEIGHT_WGSL,
  COMPOSE_COVERAGE_WGSL,
  COMPOSE_OBJECT_ID_WGSL,
  COMPOSE_MATERIAL_ID_WGSL,
  COMPOSE_CASTER_HEIGHT_WGSL,
];

// ---------------------------------------------------------------------------

describe("HeightPass  Epipeline caching and explicit layouts", () => {
  it("creates shader modules, layouts and pipelines once and reuses them", () => {
    const { mock, uploader, pass } = setup();
    uploadAndDispatch(mock, uploader, pass, simpleScene());
    expect(mock.shaderModules).toHaveLength(6); // SDF + 5 compose modules
    expect(mock.bindGroupLayouts).toHaveLength(3); // scene + sdf + compose
    expect(mock.pipelineLayouts).toHaveLength(2); // sdf + shared compose
    expect(mock.pipelines).toHaveLength(6); // SDF + 5 output-specific pipelines

    uploadAndDispatch(mock, uploader, pass, simpleScene());
    expect(mock.shaderModules).toHaveLength(6); // cached, no recompile
    expect(mock.bindGroupLayouts).toHaveLength(3);
    expect(mock.pipelineLayouts).toHaveLength(2);
    expect(mock.pipelines).toHaveLength(6);

    uploadAndDispatch(mock, uploader, pass, maskScene());
    expect(mock.shaderModules).toHaveLength(6); // still cached across scenes
    expect(mock.pipelines).toHaveLength(6);
  });

  it("uses explicit pipeline layouts (never layout: 'auto')", () => {
    const { mock, uploader, pass } = setup();
    uploadAndDispatch(mock, uploader, pass, simpleScene());
    expect(mock.pipelines[0].layout).toBe(mock.pipelineLayouts[0].layout); // SDF
    // all five compose pipelines share the same explicit layout
    for (let i = 1; i < 6; i++) {
      expect(mock.pipelines[i].layout).toBe(mock.pipelineLayouts[1].layout);
    }
    // every pipeline binds the FULL five-buffer scene layout at group 0
    for (const pipelineLayout of mock.pipelineLayouts) {
      expect(pipelineLayout.bindGroupLayouts[0]).toBe(mock.bindGroupLayouts[0].layout);
    }
    expect(mock.pipelineLayouts[0].bindGroupLayouts[1]).toBe(mock.bindGroupLayouts[1].layout);
    expect(mock.pipelineLayouts[1].bindGroupLayouts[1]).toBe(mock.bindGroupLayouts[2].layout);
  });

  it("pins the bind group layout entries with shader-derived minimum sizes", () => {
    const { mock, uploader, pass } = setup();
    uploadAndDispatch(mock, uploader, pass, maskScene());
    const sceneEntries = mock.bindGroupLayouts[0].entries;
    expect(sceneEntries).toHaveLength(5);
    const minSizes = [128, 128, 32, 4, 64]; // header, surfaces, masks, maskPixels, materials
    for (let i = 0; i < 5; i++) {
      expect(sceneEntries[i]).toMatchObject({
        binding: i,
        visibility: COMPUTE_STAGE_VISIBILITY,
        buffer: {
          type: "read-only-storage",
          hasDynamicOffset: false,
          minBindingSize: minSizes[i],
        },
      });
    }
    const sdfEntries = mock.bindGroupLayouts[1].entries;
    expect(sdfEntries).toHaveLength(3);
    expect(sdfEntries[0]).toMatchObject({
      binding: 0,
      buffer: { type: "uniform", minBindingSize: HEIGHT_PASS_PARAMS_BYTE_LENGTH },
    });
    expect(sdfEntries[1].buffer?.type).toBe("read-only-storage");
    expect(sdfEntries[1].buffer?.minBindingSize).toBe(MASK_META_STRIDE);
    expect(sdfEntries[2].buffer?.type).toBe("storage"); // workspace read_write in SDF pass
    const composeEntries = mock.bindGroupLayouts[2].entries;
    expect(composeEntries).toHaveLength(4);
    expect(composeEntries[0].buffer?.type).toBe("uniform");
    expect(composeEntries[1].buffer?.type).toBe("read-only-storage"); // maskMeta
    expect(composeEntries[2].buffer?.type).toBe("read-only-storage"); // workspace read
    expect(composeEntries[3].buffer?.type).toBe("storage"); // exactly ONE output
    for (const entries of [sdfEntries, composeEntries]) {
      for (const entry of entries) {
        expect(entry.visibility).toBe(COMPUTE_STAGE_VISIBILITY);
      }
    }
    // per-stage storage budgets: SDF 5 + 2 = 7; every compose pass 5 + 3 = 8
    const countStorage = (entries: readonly GpuBindGroupLayoutEntryLike[]) =>
      entries.filter((e) => e.buffer?.type === "storage" || e.buffer?.type === "read-only-storage")
        .length;
    expect(countStorage(sceneEntries) + countStorage(sdfEntries)).toBe(7);
    expect(countStorage(sceneEntries) + countStorage(composeEntries)).toBe(8);
  });
});

describe("HeightPass  Ecomplete bind groups", () => {
  it("consumes the exact SceneUploader binding buffers in the scene bind group", () => {
    const { mock, uploader, pass } = setup();
    const { bindings } = uploadAndDispatch(mock, uploader, pass, maskScene());
    const sceneGroup = mock.bindGroups[0];
    expect(sceneGroup.entries).toHaveLength(5);
    const expected: Array<{ binding: number; buffer: GpuBufferLike }> = [
      { binding: 0, buffer: bindings.header.buffer },
      { binding: 1, buffer: bindings.surfaces.buffer },
      { binding: 2, buffer: bindings.masks.buffer },
      { binding: 3, buffer: bindings.maskPixels.buffer },
      { binding: 4, buffer: bindings.materials.buffer },
    ];
    for (const { binding, buffer } of expected) {
      expect(sceneGroup.entries[binding].binding).toBe(binding);
      expect(sceneGroup.entries[binding].resource.buffer).toBe(buffer);
    }
  });

  it("carries every pass binding in the sdf and five compose bind groups", () => {
    const { mock, uploader, pass } = setup();
    uploadAndDispatch(mock, uploader, pass, maskScene());
    // creation order: scene(5), sdf(3), compose-height, -coverage, -objectId,
    // -materialId, -casterHeight
    const sdfGroup = mock.bindGroups[1];
    expect(sdfGroup.entries).toHaveLength(3);
    for (const entry of sdfGroup.entries) {
      expect(entry.resource.buffer.size).toBeGreaterThan(0);
    }
    const outputNames = ["outHeight", "outCoverage", "outObjectId", "outMaterialId", "outCasterHeight"];
    for (let i = 0; i < 5; i++) {
      const group = mock.bindGroups[2 + i];
      expect(group.entries).toHaveLength(4);
      for (let b = 0; b < 4; b++) {
        expect(group.entries[b].binding).toBe(b);
        expect(group.entries[b].resource.buffer.size).toBeGreaterThan(0);
      }
      expect((group.entries[3].resource.buffer as MockBuffer).usage).toBe(
        HEIGHT_PASS_OUTPUT_USAGE,
      );
      // binding 3 is that pass's OWN output allocation
      expect((group.entries[3].resource.buffer as MockBuffer).label).toBe(
        `ukibori-${outputNames[i]}`,
      );
    }
    // workspace buffer is shared by every pass bind group
    const workspace = mock.bindGroups[1].entries[2].resource.buffer;
    for (let i = 0; i < 5; i++) {
      expect(mock.bindGroups[2 + i].entries[2].resource.buffer).toBe(workspace);
    }
  });

  it("binds the full scene group to every compute pass in one dispatch", () => {
    const { mock, uploader, pass } = setup();
    uploadAndDispatch(mock, uploader, pass, maskScene());
    const encoder = mock.encoders[0];
    expect(encoder.passes).toHaveLength(6); // SDF + 5 compose passes
    for (const computePass of encoder.passes) {
      expect(computePass.calls.bindGroups[0].index).toBe(0);
      expect(computePass.calls.bindGroups[0].bindGroup).toBe(mock.bindGroups[0].bindGroup);
      expect(computePass.calls.bindGroups[1].index).toBe(1);
    }
  });
});

describe("HeightPass  Ecommand ordering and dispatch dims", () => {
  it("records pipeline, bind groups, ceil-division dispatch and end in order, then submits", () => {
    const { mock, uploader, pass } = setup();
    uploadAndDispatch(mock, uploader, pass, maskScene()); // 20x20=400 texels, 2x2 mask -> 16 cells
    const encoder = mock.encoders[0];
    expect(encoder.passes).toHaveLength(6);
    const sdf = encoder.passes[0];
    expect(sdf.calls.pipeline).toBe(mock.pipelines[0].pipeline);
    expect(sdf.log).toEqual(["setPipeline", "setBindGroup(0)", "setBindGroup(1)", "dispatch(1)", "end"]);
    expect(sdf.calls.dispatch[0]).toEqual({ x: Math.ceil(16 / WORKGROUP_SIZE), y: 1, z: 1 });
    for (let i = 0; i < 5; i++) {
      const compose = encoder.passes[1 + i];
      expect(compose.calls.pipeline).toBe(mock.pipelines[1 + i].pipeline);
      expect(compose.log).toEqual(["setPipeline", "setBindGroup(0)", "setBindGroup(1)", "dispatch(7)", "end"]);
      expect(compose.calls.dispatch[0]).toEqual({ x: Math.ceil(400 / WORKGROUP_SIZE), y: 1, z: 1 });
    }
    expect(encoder.finished).toBe(true);
    expect(mock.submits).toHaveLength(1);
    expect(mock.submits[0]).toHaveLength(1);
  });

  it("runs exactly the five compose passes for mask-free scenes", () => {
    const { mock, uploader, pass } = setup();
    const { stats } = uploadAndDispatch(mock, uploader, pass, simpleScene());
    expect(stats.maskSdfPasses).toBe(0);
    expect(stats.composePasses).toBe(5);
    const encoder = mock.encoders[0];
    expect(encoder.passes).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(encoder.passes[i].calls.pipeline).toBe(mock.pipelines[1 + i].pipeline);
    }
    const snapshot = pass.getSnapshot();
    expect(snapshot.lastDispatch.maskSdfPasses).toBe(0);
    expect(snapshot.lastDispatch.composePasses).toBe(5);
  });

  it("ceil-divides the texel dispatch from the documented workgroup size", () => {
    const { mock, uploader, pass } = setup();
    uploadAndDispatch(mock, uploader, pass, simpleScene(), 1.5); // 150x120 = 18000 texels
    const compose = mock.encoders[0].passes[0];
    expect(compose.calls.dispatch[0].x).toBe(282); // ceil(18000 / 64) = 282, not floor 281
    expect(pass.getSnapshot().lastDispatch.workgroupCountX).toBe(282);
    expect(pass.getSnapshot().lastDispatch.renderWidth).toBe(150);
    expect(pass.getSnapshot().lastDispatch.renderHeight).toBe(120);
  });
});

describe("HeightPass  Eallocation reuse and growth", () => {
  it("allocates all eight pass buffers on the first dispatch and reuses them", () => {
    const { mock, uploader, pass } = setup();
    const { stats } = uploadAndDispatch(mock, uploader, pass, simpleScene());
    expect(stats.newAllocations).toBe(8); // uniform, maskMeta, workspace, 5 outputs
    expect(stats.allocationCount).toBe(8);
    // uploader owns 5 scene buffers; the pass owns the next 8
    expect(mock.created).toHaveLength(13);
    const passBuffers = mock.created.slice(5).map((c) => c.buffer);
    const next = uploadAndDispatch(mock, uploader, pass, simpleScene());
    expect(next.stats.newAllocations).toBe(0);
    expect(mock.created).toHaveLength(13);
    expect(mock.created.slice(5).map((c) => c.buffer)).toEqual(passBuffers);
  });

  it("never creates zero-sized allocations (16-byte dummy minimum)", () => {
    const { mock, uploader, pass } = setup();
    uploadAndDispatch(mock, uploader, pass, simpleScene()); // mask-free: maskMeta/workspace are dummies
    for (const { buffer } of mock.created.slice(5)) {
      expect(buffer.size).toBeGreaterThanOrEqual(16);
    }
  });

  it("grows only the sections that outgrow their allocation and disposes the old ones", () => {
    const { mock, uploader, pass } = setup();
    uploadAndDispatch(mock, uploader, pass, simpleScene()); // render 100x80, no masks
    const passBuffers = mock.created.slice(5).map((c) => c.buffer);

    // maskScene: 20x20 render (smaller outputs -> reused); maskMeta is a
    // dummy for both scenes; the mask-SDF workspace grows to 64 bytes.
    const masked = uploadAndDispatch(mock, uploader, pass, maskScene());
    expect(masked.stats.newAllocations).toBe(1);
    expect(passBuffers.filter((b) => b.destroyed)).toHaveLength(1); // old workspace dummy
    const grown = mock.created
      .slice(5)
      .filter((c) => !c.buffer.destroyed && c.desc.label?.startsWith("ukibori-"));
    expect(grown.some((c) => c.desc.size === 4 * 4 * 4)); // 4x4 padded cells * 4 bytes

    // wideScene: 300x200 render (60000 texels) outgrows the 100x80 outputs.
    const wide = uploadAndDispatch(mock, uploader, pass, wideScene());
    expect(wide.stats.newAllocations).toBe(5); // only the five outputs grow
    expect(passBuffers.filter((b) => b.destroyed)).toHaveLength(6); // 1 + 5 outputs

    // back to a smaller scene: nothing shrinks, everything is reused.
    const again = uploadAndDispatch(mock, uploader, pass, simpleScene());
    expect(again.stats.newAllocations).toBe(0);
  });

  it("reuses the pass after dispose()", () => {
    const { mock, uploader, pass } = setup();
    uploadAndDispatch(mock, uploader, pass, simpleScene());
    pass.dispose();
    const after = uploadAndDispatch(mock, uploader, pass, simpleScene());
    expect(after.stats.newAllocations).toBe(8);
  });
});

describe("HeightPass  Eusage flags audit", () => {
  it("uses documented usage flags per allocation", () => {
    const { mock, uploader, pass } = setup();
    uploadAndDispatch(mock, uploader, pass, maskScene());
    const byLabel = new Map(
      mock.created.slice(5).map((c) => [c.desc.label ?? "", c.desc.usage]),
    );
    expect(byLabel.get("ukibori-uniform")).toBe(0x40 | 0x8); // UNIFORM | COPY_DST
    expect(byLabel.get("ukibori-maskMeta")).toBe(0x80 | 0x8); // STORAGE | COPY_DST
    expect(byLabel.get("ukibori-maskWorkspace")).toBe(0x80 | 0x4); // STORAGE | COPY_SRC
    for (const name of ["outHeight", "outCoverage", "outObjectId", "outMaterialId", "outCasterHeight"]) {
      expect(byLabel.get(`ukibori-${name}`)).toBe(0x80 | 0x4 | 0x8); // STORAGE | COPY_SRC | COPY_DST
    }
    // no MAP_READ anywhere
    for (const { buffer } of mock.created.slice(5)) {
      expect(buffer.usage & 0x1).toBe(0);
    }
  });

  it("never maps or reads back during normal dispatch (no readback surface)", () => {
    const { mock, uploader, pass } = setup();
    uploadAndDispatch(mock, uploader, pass, simpleScene());
    const queue = mock.queue as unknown as Record<string, unknown>;
    expect(queue.mapAsync).toBeUndefined();
    expect(queue.copyBufferToBuffer).toBeUndefined();
    for (const { buffer } of mock.created) {
      const b = buffer as unknown as Record<string, unknown>;
      expect(b.mapAsync).toBeUndefined();
      expect(b.getMappedRange).toBeUndefined();
    }
    // the only pass queue traffic is the params + maskMeta uploads and the
    // submit (uploader writes happen on its own buffers)
    const passBuffers = mock.created.slice(5).map((c) => c.buffer);
    const passWrites = mock.writes.filter((w) => passBuffers.includes(w.buffer));
    expect(passWrites).toHaveLength(2);
    expect(mock.submits).toHaveLength(1);
  });
});

describe("HeightPass  Evalidation and rejection", () => {
  function corrupt(bytes: Uint8Array, offset: number, fn: (view: DataView) => void): Uint8Array {
    const copy = bytes.slice();
    fn(new DataView(copy.buffer));
    return copy;
  }

  it("rejects malformed encoded scenes before any device call (strict validation)", () => {
    const { mock, uploader, pass } = setup();
    const encoded = encodeScene(simpleScene(), 1);
    uploader.upload(encoded);
    const bad = { bytes: corrupt(encoded.bytes, 0, (v) => v.setUint32(0, 0xdeadbeef, true)) };
    expect(() => pass.dispatch(bad, uploader.getBindings())).toThrow(/invalid magic/);
    // deep record corruption that bounded validation would miss: a surface
    // materialIndex out of range is caught by validateEncodedScene (the
    // surface[0] record starts at HEADER_SIZE; materialIndex is at +12)
    const badMaterial = {
      bytes: corrupt(encoded.bytes, HEADER_SIZE + 12, (v) => v.setUint32(HEADER_SIZE + 12, 7, true)),
    };
    expect(() => pass.dispatch(badMaterial, uploader.getBindings())).toThrow(
      /materialIndex 7 out of range/,
    );
    expect(mock.created).toHaveLength(5); // only the uploader's allocations exist
  });

  it("rejects bindings whose provenance does not match the dispatched scene", () => {
    const { mock, uploader, pass } = setup();
    const encodedA = encodeScene(simpleScene(), 1);
    const encodedB = encodeScene(simpleScene(), 1); // identical bytes, different object
    uploader.upload(encodedA);
    const bindings = uploader.getBindings();
    expect(() => pass.dispatch(encodedB, bindings)).toThrow(/provenance/);
    // works with the correct scene afterwards
    expect(() => pass.dispatch(encodedA, bindings)).not.toThrow();
    expect(mock.created).toHaveLength(5 + 8); // uploader + pass allocations only after a valid dispatch
  });

  it("rejects mismatched scene bindings before any device call", () => {
    const { mock, uploader, pass } = setup();
    const encoded = encodeScene(simpleScene(), 1);
    uploader.upload(encoded);
    const bindings = uploader.getBindings();
    const bad = {
      ...bindings,
      surfaces: { ...bindings.surfaces, byteLength: bindings.surfaces.byteLength - 64 },
    } as SceneBindings;
    expect(() => pass.dispatch(encoded, bad)).toThrow(/surfaces binding byteLength/);
    const badTotal = { ...bindings, sceneByteLength: bindings.sceneByteLength + 8 };
    expect(() => pass.dispatch(encoded, badTotal)).toThrow(/sceneByteLength/);
    expect(mock.created).toHaveLength(5);
  });

  it("rejects invalid mask records before any device call", () => {
    const { mock, uploader, pass } = setup();
    const encoded = encodeScene(maskScene(), 1);
    uploader.upload(encoded);
    // mask[0] alphaFormat sits at masksOffset + 8; corrupt it to an invalid enum
    const masksOffset = HEADER_SIZE + SURFACE_STRIDE;
    const badFormat = {
      bytes: corrupt(encoded.bytes, masksOffset + 8, (v) => v.setUint32(masksOffset + 8, 7, true)),
    };
    expect(() => pass.dispatch(badFormat, uploader.getBindings())).toThrow(/invalid alphaFormat/);
    expect(mock.created).toHaveLength(5);
  });

  it("rejects allocations beyond the device limits before creating buffers", () => {
    const mock = new MockDevice({ maxStorageBufferBindingSize: 4096, maxBufferSize: 4096 });
    const uploader = new SceneUploader(mock);
    const pass = new HeightPass(mock);
    const encoded = encodeScene(simpleScene(), 1); // outputs need 8000 * 4 bytes
    uploader.upload(encoded);
    expect(() => pass.dispatch(encoded, uploader.getBindings())).toThrow(/exceeds device limits/);
    expect(mock.created).toHaveLength(5);
  });

  it("rejects unsupported workgroup sizes before any device call", () => {
    const mock = new MockDevice({ maxComputeWorkgroupSizeX: 32, maxComputeInvocationsPerWorkgroup: 32 });
    const uploader = new SceneUploader(mock);
    const pass = new HeightPass(mock);
    const encoded = encodeScene(simpleScene(), 1);
    uploader.upload(encoded);
    expect(() => pass.dispatch(encoded, uploader.getBindings())).toThrow(/workgroup size 64 exceeds/);
    expect(mock.created).toHaveLength(5);
  });

  it("splits dispatch counts beyond maxComputeWorkgroupsPerDimension into band chunks", () => {
    const mock = new MockDevice({ maxComputeWorkgroupsPerDimension: 32 });
    const uploader = new SceneUploader(mock);
    const pass = new HeightPass(mock);
    const encoded = encodeScene(simpleScene(), 1); // 8000 texels -> 125 workgroups > 32
    uploader.upload(encoded);
    // rowsPerChunk = floor(32 * 64 / 100) = 20 rows -> ceil(2000 / 64) = 32 <= 32
    const stats = pass.dispatch(encoded, uploader.getBindings());
    expect(stats.submissions).toBe(4); // four row chunks; the scene is mask-free (no SDF pass)
    expect(mock.encoders).toHaveLength(4);
    for (const encoder of mock.encoders) {
      expect(encoder.passes).toHaveLength(5);
      for (const compose of encoder.passes) {
        expect(compose.calls.dispatch[0]).toEqual({ x: 32, y: 1, z: 1 });
      }
    }
    // the total documented count is unchanged ...
    expect(pass.getSnapshot().lastDispatch.workgroupCountX).toBe(125);
    // ... and every texel row is covered by exactly one chunk's params:
    const uniform = mock.created.slice(5).find((c) => c.desc.label === "ukibori-uniform")!.buffer;
    const chunkWrites = mock.writes.filter(
      (w) => w.buffer === uniform && w.bytes.byteLength === HEIGHT_PASS_PARAMS_BYTE_LENGTH,
    );
    expect(chunkWrites).toHaveLength(5); // the pre-pipeline write + one per chunk
    const covered: Array<[number, number]> = [];
    for (let i = 1; i < chunkWrites.length; i++) {
      const view = new DataView(chunkWrites[i].bytes.buffer);
      const yOffset = view.getUint32(8, true);
      const regionEnd = view.getUint32(12, true);
      covered.push([yOffset, regionEnd]);
    }
    expect(covered).toEqual([
      [0, 2000],
      [2000, 4000],
      [4000, 6000],
      [6000, 8000],
    ]);
  });

  it("throws when a single texel row alone exceeds maxComputeWorkgroupsPerDimension", () => {
    const mock = new MockDevice({ maxComputeWorkgroupsPerDimension: 32 });
    const uploader = new SceneUploader(mock);
    const pass = new HeightPass(mock);
    // 4000 x 1 texels: ceil(4000 / 64) = 63 workgroups in ONE row  Eno band
    // split can help, so the dispatch is rejected before any allocation.
    const wide = createScene({
      width: 4000,
      height: 1,
      surfaces: [
        {
          id: "w",
          position: { x: 0, y: 0 },
          size: { x: 10, y: 1 },
          elevation: 1,
          shape: { kind: "roundedRect", radius: 0 },
          profile: { kind: "flat" },
          material: "silicone",
          castsShadow: false,
          receivesShadow: false,
        },
      ],
      light: { direction: { x: -0.6, y: -0.8, z: 1 }, intensity: 2 },
    });
    const encoded = encodeScene(wide, 1);
    uploader.upload(encoded);
    expect(() => pass.dispatch(encoded, uploader.getBindings())).toThrow(
      /dispatch chunk of 63 workgroups exceeds maxComputeWorkgroupsPerDimension/,
    );
    expect(mock.created).toHaveLength(5); // rejected before any pass allocation
  });

  it("rejects devices with fewer than 8 storage buffers per shader stage", () => {
    const mock = new MockDevice({ maxStorageBuffersPerShaderStage: 4 });
    const uploader = new SceneUploader(mock);
    const pass = new HeightPass(mock);
    const encoded = encodeScene(simpleScene(), 1);
    uploader.upload(encoded);
    expect(() => pass.dispatch(encoded, uploader.getBindings())).toThrow(
      /maxStorageBuffersPerShaderStage/,
    );
    expect(mock.created).toHaveLength(5);
  });

  it("rejects a render texel count above u32 before any device call", () => {
    const { mock, uploader, pass } = setup();
    // 70000 x 70000 = 4.9e9 texels > u32 max (0xffffffff); both dimensions
    // are individually valid u32 values and pass strict validation
    const huge = createScene({ width: 70000, height: 70000, surfaces: [] });
    const encoded = encodeScene(huge, 1);
    uploader.upload(encoded);
    expect(() => pass.dispatch(encoded, uploader.getBindings())).toThrow(
      /render texel count 70000x70000 exceeds u32/,
    );
    expect(mock.created).toHaveLength(5); // rejected before any pass allocation
  });

  it("validates maskMeta allocation bytes before ensureAllocation", () => {
    // 1025 one-pixel masks + 1025 surfaces: the #32 maskMeta layout needs
    // (1 + 1025 surfaces + 1025 masks) * 4 = 8204 bytes > the 4096-byte
    // limit; the mask-meta check runs before the workspace/output checks
    const surfaces: Scene["surfaces"] = [];
    for (let i = 0; i < 1025; i++) {
      surfaces.push({
        id: `m${i}`,
        position: { x: 0, y: 0 },
        size: { x: 1, y: 1 },
        elevation: 0,
        thickness: 1,
        shape: { kind: "mask", mask: { width: 1, height: 1, alpha: new Uint8Array([255]) } },
        profile: { kind: "flat" },
        material: "silicone",
        castsShadow: false,
        receivesShadow: false,
      });
    }
    const mock = new MockDevice({ maxStorageBufferBindingSize: 4096, maxBufferSize: 4096 });
    const uploader = new SceneUploader(mock);
    const pass = new HeightPass(mock);
    const encoded = encodeScene(createScene({ width: 100, height: 80, surfaces }), 1);
    uploader.upload(encoded);
    expect(() => pass.dispatch(encoded, uploader.getBindings())).toThrow(
      /mask meta allocation of 8204 bytes exceeds device limits/,
    );
    expect(mock.created).toHaveLength(5);
  });
});

describe("HeightPass  Eoutput snapshot", () => {
  it("throws before the first dispatch and after dispose", () => {
    const { mock, uploader, pass } = setup();
    expect(() => pass.getSnapshot()).toThrow(/no dispatch/);
    expect(() => pass.getOutputs()).toThrow(/no dispatch/);
    uploadAndDispatch(mock, uploader, pass, simpleScene());
    pass.dispose();
    expect(() => pass.getSnapshot()).toThrow(/no dispatch/);
    expect(() => pass.getOutputs()).toThrow(/no dispatch/);
    pass.dispose(); // idempotent
  });

  it("exposes formats, logical byte lengths, usage, workgroup size and last dispatch dims", () => {
    const { mock, uploader, pass } = setup();
    uploadAndDispatch(mock, uploader, pass, maskScene(), 1.5); // 20x20 @1.5 -> 30x30 = 900 texels
    const snapshot = pass.getSnapshot();
    expect(snapshot.width).toBe(30);
    expect(snapshot.height).toBe(30);
    expect(snapshot.dpr).toBe(1.5);
    expect(snapshot.workgroupSize).toBe(WORKGROUP_SIZE);
    expect(snapshot.lastDispatch).toMatchObject({
      renderWidth: 30,
      renderHeight: 30,
      workgroupCountX: Math.ceil(900 / WORKGROUP_SIZE),
      maskCount: 1,
      totalMaskCells: 16,
      maskSdfPasses: 1,
      composePasses: 5,
    });
    const outputs = snapshot.outputs;
    expect(outputs.height.format).toBe("f32");
    expect(outputs.coverage.format).toBe("u32");
    expect(outputs.objectId.format).toBe("u32");
    expect(outputs.materialId.format).toBe("u32");
    expect(outputs.casterHeight.format).toBe("f32");
    for (const out of [
      outputs.height,
      outputs.coverage,
      outputs.objectId,
      outputs.materialId,
      outputs.casterHeight,
    ]) {
      expect(out.byteLength).toBe(900 * 4);
      expect(out.usage).toBe(HEIGHT_PASS_OUTPUT_USAGE);
      expect(out.buffer.size).toBeGreaterThanOrEqual(900 * 4);
    }
    expect(pass.getOutputs().height.buffer).toBe(outputs.height.buffer); // stable snapshot
  });

  it("packs the params uniform and mask metadata little-endian at the pinned offsets", () => {
    const { mock, uploader, pass } = setup();
    uploadAndDispatch(mock, uploader, pass, maskScene());
    const passBuffers = mock.created.slice(5).map((c) => c.buffer);
    const passWrites = mock.writes.filter((w) => passBuffers.includes(w.buffer));
    expect(passWrites).toHaveLength(2); // uniform, then maskMeta (dispatch order)
    const uniformWrite = passWrites[0];
    expect(uniformWrite.bytes.byteLength).toBe(HEIGHT_PASS_PARAMS_BYTE_LENGTH);
    const view = new DataView(uniformWrite.bytes.buffer);
    expect(view.getUint32(0, true)).toBe(16); // totalMaskCells (4x4 padded)
    expect(view.getUint32(4, true)).toBe(WORKGROUP_SIZE);
    expect(view.getUint32(8, true)).toBe(0); // yOffset (full frame)
    expect(view.getUint32(12, true)).toBe(0); // regionEnd (full-frame sentinel)

    // #32 maskMeta layout on a FULL frame: element 0 is the sentinel,
    // elements 1..1+surfaceCount are the (zeroed) candidate bin, and the
    // mask workspace offsets live at the fixed 1 + surfaceCount base.
    const metaWrite = passWrites[1];
    expect(metaWrite.bytes.byteLength).toBe(16); // (1 + 1 surface + 1 mask) * 4, 16-byte floor
    const meta = new DataView(metaWrite.bytes.buffer);
    expect(meta.getUint32(0, true)).toBe(MASK_META_FULL_SENTINEL); // full-frame sentinel
    expect(meta.getUint32(4, true)).toBe(0); // candidate element 1 (zeroed on full frames)
    expect(meta.getUint32(8, true)).toBe(0); // mask[0] workspaceByteOffset at base 1+surfaceCount
  });

  it("packs a partial candidate bin (count + ORIGINAL indices) with the sentinel absent", () => {
    const { mock, uploader, pass } = setup();
    // 2 surfaces + 1 mask: maskMeta layout = [count, c0, c1, mask0 offset]
    const encoded = encodeScene(
      createScene({
        width: 20,
        height: 20,
        surfaces: [
          {
            id: "r",
            position: { x: 0, y: 0 },
            size: { x: 5, y: 5 },
            elevation: 0,
            thickness: 1,
            shape: { kind: "roundedRect", radius: 0 },
            profile: { kind: "flat" },
            material: "silicone",
            castsShadow: false,
            receivesShadow: false,
          },
          {
            id: "m",
            position: { x: 10, y: 10 },
            size: { x: 8, y: 8 },
            elevation: 0,
            shape: { kind: "mask", mask: { width: 2, height: 2, alpha: new Uint8Array([0, 128, 255, 64]) } },
            profile: { kind: "flat" },
            material: "silicone",
            castsShadow: false,
            receivesShadow: false,
          },
        ],
      }),
      1,
    );
    uploader.upload(encoded);
    pass.dispatch(encoded, uploader.getBindings());
    const passBuffers = mock.created.slice(5).map((c) => c.buffer);
    // a partial dispatch over rows 0..7 with the validated ascending bin
    pass.dispatch(encoded, uploader.getBindings(), {
      region: { y0: 0, y1: 7 },
      candidates: [0, 1],
    });
    const metaWrite = mock.writes.filter((w) => passBuffers.includes(w.buffer)).at(-1)!;
    expect(metaWrite.bytes.byteLength).toBe(16); // (1 + 2 surfaces + 1 mask) * 4
    const meta = new DataView(metaWrite.bytes.buffer);
    expect(meta.getUint32(0, true)).toBe(2); // candidate count (NOT the sentinel)
    expect(meta.getUint32(4, true)).toBe(0); // candidate[0] == ORIGINAL index 0
    expect(meta.getUint32(8, true)).toBe(1); // candidate[1] == ORIGINAL index 1
    expect(meta.getUint32(12, true)).toBe(0); // mask[0] workspaceByteOffset at 1+surfaceCount
  });

  it("supports a zero-candidate partial band (count 0, cleared outputs)", () => {
    const { mock, uploader, pass } = setup();
    const encoded = encodeScene(simpleScene(), 1);
    uploader.upload(encoded);
    pass.dispatch(encoded, uploader.getBindings());
    const passBuffers = mock.created.slice(5).map((c) => c.buffer);
    pass.dispatch(encoded, uploader.getBindings(), {
      region: { y0: 8, y1: 15 },
      candidates: [],
    });
    const metaWrite = mock.writes.filter((w) => passBuffers.includes(w.buffer)).at(-1)!;
    const meta = new DataView(metaWrite.bytes.buffer);
    expect(meta.getUint32(0, true)).toBe(0); // zero candidates
    expect(meta.getUint32(4, true)).toBe(0);
    expect(meta.getUint32(8, true)).toBe(0);
  });

  it("rejects candidate bins that are invalid or not paired with a region", () => {
    const { mock, uploader, pass } = setup();
    const encoded = encodeScene(maskScene(), 1);
    uploader.upload(encoded);
    const bindings = uploader.getBindings();
    const region = { y0: 0, y1: 7 };
    expect(() =>
      pass.dispatch(encoded, bindings, { region, candidates: [0, 0] }),
    ).toThrow(/strictly ascending/);
    expect(() =>
      pass.dispatch(encoded, bindings, { region, candidates: [2] }),
    ).toThrow(/out of range/);
    expect(() =>
      pass.dispatch(encoded, bindings, { region, candidates: [0, -1] }),
    ).toThrow(/out of range/);
    // partial candidates REQUIRE a partial region (full frames use the sentinel)
    expect(() =>
      pass.dispatch(encoded, bindings, { candidates: [0] }),
    ).toThrow(/require a partial dispatch region/);
  });

  it("records a unique per-dispatch provenance token tied to the exact scene bytes", () => {
    const { mock, uploader, pass } = setup();
    const first = encodeScene(simpleScene(), 1);
    uploader.upload(first);
    pass.dispatch(first, uploader.getBindings());
    const firstProvenance = pass.getSnapshot().provenance;
    expect(firstProvenance.sceneBytes).toBe(first.bytes);
    expect(firstProvenance).toBe(pass.getSnapshot().provenance);
    expect(firstProvenance).toMatchObject({ width: 100, height: 80, dpr: 1 });

    // A second dispatch of the SAME bytes object gets a new execution token,
    // allowing later passes to detect a mixed set of otherwise-identical
    // fields from two dispatches.
    pass.dispatch(first, uploader.getBindings());
    const repeatedProvenance = pass.getSnapshot().provenance;
    expect(repeatedProvenance).not.toBe(firstProvenance);
    expect(repeatedProvenance.sceneBytes).toBe(first.bytes);

    // a different encoded scene object (identical bytes content) has a
    // different scene-byte identity as well
    const second = encodeScene(simpleScene(), 1);
    expect(second.bytes).not.toBe(first.bytes);
    uploader.upload(second);
    pass.dispatch(second, uploader.getBindings());
    expect(pass.getSnapshot().provenance.sceneBytes).toBe(second.bytes);
    expect(pass.getSnapshot().provenance).not.toBe(repeatedProvenance);
  });
});

describe("HeightPass  Edisposal", () => {
  it("destroys every owned allocation, keeps foreign buffers, and is idempotent", () => {
    const { mock, uploader, pass } = setup();
    uploadAndDispatch(mock, uploader, pass, simpleScene());
    const passBuffers = mock.created.slice(5).map((c) => c.buffer);
    const sceneBuffers = mock.created.slice(0, 5).map((c) => c.buffer);
    pass.dispose();
    for (const buffer of passBuffers) {
      expect(buffer.destroyed).toBe(true);
    }
    for (const buffer of sceneBuffers) {
      expect(buffer.destroyed).toBe(false); // uploader still owns these
    }
    pass.dispose(); // no throw
  });
});

// ---------------------------------------------------------------------------
// Shader/layout contract assertions. These PIN the WGSL against the host
// layout and the CPU semantics (sampling, coverage, tie rules, mask
// thresholds). They are string-level checks only  Enumeric parity is the
// real-GPU browser test, never a mock claim.
// ---------------------------------------------------------------------------

describe("HeightPass shaders  Ebinding contract", () => {
  it("declares the full frozen ABI group-0 bindings 0-4 in EVERY module", () => {
    const all = [MASK_SDF_WGSL, ...COMPOSE_MODULES];
    for (const wgsl of all) {
      expect(wgsl).toContain("@group(0) @binding(0) var<storage, read> sceneHeader: SceneHeader;");
      expect(wgsl).toContain("@group(0) @binding(1) var<storage, read> surfaces: array<SurfaceRecord>;");
      expect(wgsl).toContain("@group(0) @binding(2) var<storage, read> masks: array<MaskRecord>;");
      expect(wgsl).toContain("@group(0) @binding(3) var<storage, read> maskPixels: array<u32>;");
      expect(wgsl).toContain("@group(0) @binding(4) var<storage, read> materials: array<MaterialRecord>;");
    }
    // WGSL_LAYOUT keeps the complete declaration too
    expect(WGSL_LAYOUT).toContain("@group(0) @binding(4) var<storage, read> materials: array<MaterialRecord>;");
  });

  it("genuinely consumes all five scene buffers in the shaders", () => {
    // sceneHeader: dims/counts/DPR read directly
    expect(MASK_SDF_WGSL).toContain("sceneHeader.maskCount");
    for (const wgsl of COMPOSE_MODULES) {
      expect(wgsl).toContain("sceneHeader.renderWidth");
      expect(wgsl).toContain("sceneHeader.renderHeight");
      expect(wgsl).toContain("sceneHeader.dpr");
      expect(wgsl).toContain("sceneHeader.surfaceCount");
    }
    // materialCount is read by the material-id pass (the only one that
    // consults the MaterialRecord)
    expect(COMPOSE_MATERIAL_ID_WGSL).toContain("sceneHeader.materialCount");
    expect(COMPOSE_HEIGHT_WGSL).not.toContain("sceneHeader.materialCount");
    // surfaces: geometry/owner in every compose pass (owner-indexed access
    // happens in the material-id pass)
    for (const wgsl of COMPOSE_MODULES) {
      expect(wgsl).toContain("let s = surfaces[i];");
    }
    expect(COMPOSE_MATERIAL_ID_WGSL).toContain("surfaces[r.owner].materialIndex");
    // masks + maskPixels: the SDF pass reads MaskRecord fields and alpha
    expect(MASK_SDF_WGSL).toContain("let mask = masks[maskIndex];");
    expect(MASK_SDF_WGSL).toContain("mask.width");
    expect(MASK_SDF_WGSL).toContain("mask.height");
    expect(MASK_SDF_WGSL).toContain("mask.alphaFormat");
    expect(MASK_SDF_WGSL).toContain("mask.pixelOffset");
    expect(MASK_SDF_WGSL).toContain("maskPixels[byteOffset >> 2u]");
    // mask-shape sampling reads MaskRecord dimensions directly
    for (const wgsl of COMPOSE_MODULES) {
      expect(wgsl).toContain("let mask = masks[maskIndex];");
      expect(wgsl).toContain("let mw = f32(mask.width);");
    }
    // materials: genuinely read in the material-id pass
    expect(COMPOSE_MATERIAL_ID_WGSL).toContain("materials[matIndex].flags");
  });

  it("keeps the group-1 pass bindings drift-free", () => {
    expect(MASK_SDF_WGSL).toContain("@group(1) @binding(0) var<uniform> params: HeightPassParams;");
    expect(MASK_SDF_WGSL).toContain("@group(1) @binding(1) var<storage, read> maskMeta: array<u32>;");
    expect(MASK_SDF_WGSL).toContain("@group(1) @binding(2) var<storage, read_write> maskWorkspace: array<f32>;");
    expect(MASK_SDF_WGSL).not.toContain("@group(1) @binding(3)"); // no output in the SDF pass
    for (const wgsl of COMPOSE_MODULES) {
      expect(wgsl).toContain("@group(1) @binding(0) var<uniform> params: HeightPassParams;");
      expect(wgsl).toContain("@group(1) @binding(1) var<storage, read> maskMeta: array<u32>;");
      expect(wgsl).toContain("@group(1) @binding(2) var<storage, read> maskWorkspace: array<f32>;");
      // exactly ONE output at binding 3
      expect(wgsl).toContain("@group(1) @binding(3) var<storage, read_write>");
      expect(wgsl).not.toContain("read_write> maskWorkspace");
    }
    // each compose module writes only its own output
    expect(COMPOSE_HEIGHT_WGSL).toContain("outHeight: array<f32>");
    expect(COMPOSE_HEIGHT_WGSL).not.toContain("outCoverage");
    expect(COMPOSE_HEIGHT_WGSL).not.toContain("outObjectId");
    expect(COMPOSE_HEIGHT_WGSL).not.toContain("outMaterialId");
    expect(COMPOSE_COVERAGE_WGSL).toContain("outCoverage: array<u32>");
    expect(COMPOSE_COVERAGE_WGSL).not.toContain("outHeight");
    expect(COMPOSE_OBJECT_ID_WGSL).toContain("outObjectId: array<u32>");
    expect(COMPOSE_OBJECT_ID_WGSL).not.toContain("outCoverage");
    expect(COMPOSE_MATERIAL_ID_WGSL).toContain("outMaterialId: array<u32>");
    expect(COMPOSE_MATERIAL_ID_WGSL).not.toContain("outObjectId");
  });

  it("pins the params and mask-meta byte offsets in the WGSL comments", () => {
    expect(MASK_SDF_WGSL).toContain("totalMaskCells: u32,   //  0");
    expect(MASK_SDF_WGSL).toContain("workgroupSize: u32,    //  4");
    expect(COMPOSE_HEIGHT_WGSL).toContain("totalMaskCells: u32,   //  0");
    expect(MASK_SDF_WGSL).toContain("maskMeta: array<u32>");
    expect(MASK_SDF_WGSL).toContain("NO_OWNER 4294967295"); // WGSL_LAYOUT sentinel comment
    expect(HEIGHT_PASS_PARAMS_BYTE_LENGTH).toBe(16);
    expect(MASK_META_STRIDE).toBe(4);
  });

  it("keeps the documented workgroup size and in-shader bounds guards", () => {
    expect(WORKGROUP_SIZE).toBe(64);
    for (const wgsl of [MASK_SDF_WGSL, ...COMPOSE_MODULES]) {
      expect(wgsl).toContain(`@workgroup_size(WORKGROUP_SIZE)`); // WGSL const, pinned to 64
    }
    expect(MASK_SDF_WGSL).toContain("if (g >= params.totalMaskCells)");
    for (const wgsl of COMPOSE_MODULES) {
      expect(wgsl).toContain("if (g >= texelCount)");
      expect(wgsl).toContain("let texelCount = sceneHeader.renderWidth * sceneHeader.renderHeight;");
    }
  });
});

describe("HeightPass shaders  ECPU semantics pinned in WGSL", () => {
  it("samples render texels at ((tx + 0.5) / dpr, (ty + 0.5) / dpr) from the header", () => {
    for (const wgsl of COMPOSE_MODULES) {
      expect(wgsl).toContain("let sx = (f32(tx) + 0.5) / sceneHeader.dpr;");
      expect(wgsl).toContain("let sy = (f32(ty) + 0.5) / sceneHeader.dpr;");
    }
  });

  it("applies the larger-height-wins and exact-later-tie composition rule", () => {
    for (const wgsl of COMPOSE_MODULES) {
      expect(wgsl).toContain("var best = 0.0;");
      expect(wgsl).toContain("var owner = NO_OWNER;");
      expect(wgsl).toContain("if (h > best || h == best) {");
      expect(wgsl).toContain("return OwnerResult(best, owner);");
    }
    expect(COMPOSE_COVERAGE_WGSL).toContain("select(0u, 1u, r.owner != NO_OWNER)");
    expect(COMPOSE_OBJECT_ID_WGSL).toContain("outObjectId[g] = r.owner;");
    expect(COMPOSE_HEIGHT_WGSL).toContain("select(0.0, r.best, r.owner != NO_OWNER)");
    expect(COMPOSE_MATERIAL_ID_WGSL).toContain("select(matIndex, NO_OWNER, materials[matIndex].flags != 0u)");
  });

  it("culls with conservative ABI bounds before SDF evaluation", () => {
    for (const wgsl of COMPOSE_MODULES) {
      expect(wgsl).toContain("sx < s.bounds.x || sx > s.bounds.z || sy < s.bounds.y || sy > s.bounds.w");
    }
  });

  it("mirrors roundedRectSdf with the radius clamp", () => {
    for (const wgsl of COMPOSE_MODULES) {
      expect(wgsl).toContain("let r = min(s.radius, min(halfW, halfH));");
      expect(wgsl).toContain("let qx = abs(pdx) - halfW + r;");
      expect(wgsl).toContain("let inner = min(max(qx, qy), 0.0);");
      expect(wgsl).toContain("distance = outer + inner - r;");
    }
  });

  it("mirrors evaluateProfile (flat step, inward-only bevel smoothstep, zero bevel width)", () => {
    for (const wgsl of COMPOSE_MODULES) {
      expect(wgsl).toContain("if (distance >= 0.0) {");
      expect(wgsl).toContain("let u = clamp((distance + s.bevelWidth) / s.bevelWidth, 0.0, 1.0);");
      expect(wgsl).toContain("let falloff = u * u * (3.0 - 2.0 * u);");
      expect(wgsl).toContain("if (s.bevelWidth <= 0.0) {");
    }
  });

  it("mirrors computeMaskSdf thresholds, padding, 2x boundary grid and bilinear sampling", () => {
    expect(MASK_SDF_WGSL).toContain("const PAD: u32 = 1u;");
    expect(MASK_SDF_WGSL).toContain("const U8_INK_THRESHOLD: u32 = 128u;");
    expect(MASK_SDF_WGSL).toContain("const F32_INK_THRESHOLD: f32 = 0.5;");
    expect(MASK_SDF_WGSL).toContain(">= U8_INK_THRESHOLD");
    expect(MASK_SDF_WGSL).toContain(">= F32_INK_THRESHOLD");
    // exact boundary scan: perpendicular distances per row/column band plus
    // Euclidean distance to the nearest segment endpoint
    expect(MASK_SDF_WGSL).toContain("vert = min(vert, abs(px - f32(2u * cc + 2u)));");
    expect(MASK_SDF_WGSL).toContain("hor = min(hor, abs(py - f32(2u * rr + 2u)));");
    expect(MASK_SDF_WGSL).toContain("corner = min(corner,");
    expect(MASK_SDF_WGSL).toContain("let dist2x = min(vert, min(hor, sqrt(corner)));");
    expect(MASK_SDF_WGSL).toContain("select(distance, -distance, inside);");
    // composition samples the padded grid bilinearly with raster-edge clamping
    for (const wgsl of COMPOSE_MODULES) {
      expect(wgsl).toContain("let fx = clamp(px + 0.5, 0.0, f32(pw - 1u));");
      expect(wgsl).toContain("let top = v00 + (v10 - v00) * tx;");
      expect(wgsl).toContain("let scale = s.localSize.x / mw;");
    }
  });

  it("resolves mask pixels through section-relative blob offsets derived from the header", () => {
    expect(MASK_SDF_WGSL).toContain("let byteOffset = blobSectionOffset + index;");
    expect(MASK_SDF_WGSL).toContain("let word = maskPixels[byteOffset >> 2u];");
    expect(MASK_SDF_WGSL).toContain("(word >> ((byteOffset & 3u) * 8u)) & 0xffu");
    expect(MASK_SDF_WGSL).toContain("bitcast<f32>(maskPixels[(blobSectionOffset + index * 4u) >> 2u])");
    expect(MASK_SDF_WGSL).toContain("let blob = mask.pixelOffset - maskPixelsSectionBase();");
    expect(MASK_SDF_WGSL).toContain("fn maskPixelsSectionBase() -> u32");
  });
});

describe("HeightPass shaders  Ecaster-only composition (#27)", () => {
  it("searches ONLY FLAG_CASTS_SHADOW surfaces with an independent owner scan", () => {
    // the caster pass must not filter the already selected full owner: the
    // WGSL must contain the FLAG_CASTS_SHADOW gate INSIDE its own surface
    // loop (an independent caster-only search)
    expect(COMPOSE_CASTER_HEIGHT_WGSL).toContain("const FLAG_CASTS_SHADOW: u32 = 0x1u;");
    expect(COMPOSE_CASTER_HEIGHT_WGSL).toContain(
      'if ((s.flags & FLAG_CASTS_SHADOW) == 0u) {',
    );
    expect(COMPOSE_CASTER_HEIGHT_WGSL).toContain("fn casterOwnerAt(sx: f32, sy: f32) -> OwnerResult");
    expect(COMPOSE_CASTER_HEIGHT_WGSL).toContain("let r = casterOwnerAt(sx, sy);");
    // same composition rule as the full field: larger f32 height wins,
    // exact ties go to the later surface
    expect(COMPOSE_CASTER_HEIGHT_WGSL).toContain("if (h > best || h == best) {");
    expect(COMPOSE_CASTER_HEIGHT_WGSL).toContain("let s = surfaces[i];");
    // writes the caster owner's height, 0.0 for no casting owner
    expect(COMPOSE_CASTER_HEIGHT_WGSL).toContain(
      "outCasterHeight[g] = select(0.0, r.best, r.owner != NO_OWNER);",
    );
    // the FULL-field passes never reference the caster-only path and the
    // caster module never references ownerAt
    expect(COMPOSE_HEIGHT_WGSL).not.toContain("casterOwnerAt");
    expect(COMPOSE_CASTER_HEIGHT_WGSL).not.toContain("let r = ownerAt(sx, sy);");
    expect(COMPOSE_CASTER_HEIGHT_WGSL).not.toContain("outObjectId");
  });

  it("keeps the caster pass inside the same group-1 binding budget", () => {
    // one uniform + maskMeta + maskWorkspace + exactly ONE output = the
    // standard compose layout (5 scene storage + 3 = 8)
    expect(COMPOSE_CASTER_HEIGHT_WGSL).toContain("@group(1) @binding(0) var<uniform> params: HeightPassParams;");
    expect(COMPOSE_CASTER_HEIGHT_WGSL).toContain("@group(1) @binding(1) var<storage, read> maskMeta: array<u32>;");
    expect(COMPOSE_CASTER_HEIGHT_WGSL).toContain("@group(1) @binding(2) var<storage, read> maskWorkspace: array<f32>;");
    expect(COMPOSE_CASTER_HEIGHT_WGSL).toContain(
      "@group(1) @binding(3) var<storage, read_write> outCasterHeight: array<f32>;",
    );
    // same DPR-aware texel sampling and bounds guard as every compose pass
    expect(COMPOSE_CASTER_HEIGHT_WGSL).toContain("let sx = (f32(tx) + 0.5) / sceneHeader.dpr;");
    expect(COMPOSE_CASTER_HEIGHT_WGSL).toContain("if (g >= texelCount) {");
  });
});

// ---------------------------------------------------------------------------
// #46 benchmark-only substage timestamp seam: the SDF pass writes the sdf
// query pair and the first/last compose pass write the compose pair of a
// caller-owned query set; mutually exclusive with the stage timestampWrites.
// ---------------------------------------------------------------------------

describe("HeightPass substage timestamps", () => {
  it("writes the sdf pair on the SDF pass and the compose pair across compose passes", () => {
    const mock = new MockDevice();
    const uploader = new SceneUploader(mock);
    const pass = new HeightPass(mock);
    const encoded = encodeScene(maskScene(), 1);
    uploader.upload(encoded);
    const bindings = uploader.getBindings();
    const querySet = { destroy: () => {} };
    pass.dispatch(encoded, bindings, {
      substageTimestamps: {
        querySet,
        sdfBeginIndex: 0,
        composeBeginIndex: 2,
      },
    });
    const encoder = mock.encoders[mock.encoders.length - 1];
    const descriptors = encoder.passDescriptors;
    // pass 0: the mask-SDF pass -> sdf pair (0, 1)
    expect(descriptors[0].timestampWrites).toEqual({
      querySet,
      beginningOfPassWriteIndex: 0,
      endOfPassWriteIndex: 1,
    });
// pass 1..4: compose -> beginning on the first compose pass, end on the last
    expect(descriptors[1].timestampWrites).toEqual({
      querySet,
      beginningOfPassWriteIndex: 2,
    });
    expect(descriptors[5].timestampWrites).toEqual({
      querySet,
      endOfPassWriteIndex: 3,
    });
    // middle compose passes carry no timestamp writes
    expect(descriptors[2].timestampWrites).toBeUndefined();
    expect(descriptors[3].timestampWrites).toBeUndefined();
    expect(descriptors[4].timestampWrites).toBeUndefined();
  });

  it("mask-free scenes write only the compose pair", () => {
    const mock = new MockDevice();
    const uploader = new SceneUploader(mock);
    const pass = new HeightPass(mock);
    const encoded = encodeScene(simpleScene(), 1);
    uploader.upload(encoded);
    const bindings = uploader.getBindings();
    const querySet = { destroy: () => {} };
    pass.dispatch(encoded, bindings, {
      substageTimestamps: {
        querySet,
        sdfBeginIndex: 0,
        composeBeginIndex: 2,
      },
    });
    const encoder = mock.encoders[mock.encoders.length - 1];
    const descriptors = encoder.passDescriptors;
    // no SDF pass; the compose stage spans passes 0..4
    expect(descriptors[0].timestampWrites).toEqual({
      querySet,
      beginningOfPassWriteIndex: 2,
    });
    expect(descriptors[4].timestampWrites).toEqual({
      querySet,
      endOfPassWriteIndex: 3,
    });
  });

  it("rejects substageTimestamps combined with stage timestampWrites", () => {
    const mock = new MockDevice();
    const uploader = new SceneUploader(mock);
    const pass = new HeightPass(mock);
    const encoded = encodeScene(simpleScene(), 1);
    uploader.upload(encoded);
    const bindings = uploader.getBindings();
    expect(() =>
      pass.dispatch(encoded, bindings, {
        timestampWrites: {
          querySet: { destroy: () => {} },
          beginningOfPassWriteIndex: 0,
          endOfPassWriteIndex: 1,
        },
        substageTimestamps: {
          querySet: { destroy: () => {} },
          sdfBeginIndex: 0,
          composeBeginIndex: 2,
        },
      }),
    ).toThrow(/mutually exclusive/);
  });

  it("leaves the historical pass descriptors untouched without the seam", () => {
    const mock = new MockDevice();
    const uploader = new SceneUploader(mock);
    const pass = new HeightPass(mock);
    const encoded = encodeScene(simpleScene(), 1);
    uploader.upload(encoded);
    const bindings = uploader.getBindings();
    pass.dispatch(encoded, bindings);
    const encoder = mock.encoders[mock.encoders.length - 1];
    for (const descriptor of encoder.passDescriptors) {
      expect(descriptor.timestampWrites).toBeUndefined();
    }
  });
});
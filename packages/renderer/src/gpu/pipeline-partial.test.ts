import { describe, expect, it } from "vitest";
import { createScene } from "../scene";
import type { Scene, SceneInput } from "../scene";
import { encodeScene } from "./encode";
import { computeFrameKey } from "./dirty";
import type { FrameKey } from "./dirty";
import { planPartialScene } from "./tiles";
import { PARTIAL_DISPATCH_RATIO } from "./tiles";
import { MASK_META_FULL_SENTINEL } from "./height-pass-wgsl";
import { computeVisibility } from "../shadow";
import { reconstructVisibility } from "../shadow-reconstruct";
import { computeNormals, shadeHeightField } from "../lighting";
import { composeSdfHeightField } from "../geometry";
import type {
  GpuBindGroupEntryLike,
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
// Full structural mock (same surface as pipeline.test.ts)
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
  setPipeline(): void {}
  setBindGroup(): void {}
  draw(): void {}
  end(): void {}
}

class MockFullEncoder implements GpuPresentationEncoderLike {
  readonly log: string[] = [];
  beginComputePass(): {
    setPipeline(): void;
    setBindGroup(): void;
    dispatchWorkgroups(workgroupCountX: number): void;
    end(): void;
  } {
    this.log.push("beginComputePass");
    const log = this.log;
    return {
      setPipeline(): void {
        log.push("setPipeline");
      },
      setBindGroup(): void {
        log.push("setBindGroup");
      },
      dispatchWorkgroups(workgroupCountX: number): void {
        log.push(`dispatch(${workgroupCountX})`);
      },
      end(): void {
        log.push("end");
      },
    };
  }
  beginRenderPass(): GpuRenderPassEncoderLike {
    this.log.push("beginRenderPass");
    return new MockRenderPass();
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

  createRenderPipeline(): GpuRenderPipelineLike {
    return { label: "ukibori-presentation-pass" };
  }

  createBindGroupLayout(desc: { label?: string }): GpuBindGroupLayoutLike {
    return { label: desc.label };
  }

  createPipelineLayout(desc: { label?: string }): GpuPipelineLayoutLike {
    return { label: desc.label };
  }

  createBindGroup(desc: { label?: string; entries: readonly GpuBindGroupEntryLike[] }): GpuBindGroupLike {
    return { label: desc.label };
  }

  createCommandEncoder(): MockFullEncoder {
    if (this.failNextEncoder) {
      this.failNextEncoder = false;
      throw new Error("injected encoder failure");
    }
    const encoder = new MockFullEncoder();
    this.encoders.push(encoder);
    return encoder;
  }
}

// ---------------------------------------------------------------------------
// Tall scene: 100x200 so a small local edit leaves a partial band below the
// documented PARTIAL_DISPATCH_RATIO. Bounded shadow maxDistance keeps the
// down-light halo local (the default scene-diagonal maxDistance would expand
// the halo across the whole frame and force the full path, by design).
// ---------------------------------------------------------------------------

const TALL_SCENE: SceneInput = {
  width: 100,
  height: 200,
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
    {
      id: "b",
      position: { x: 60, y: 140 },
      size: { x: 20, y: 20 },
      elevation: 1,
      thickness: 1,
      shape: { kind: "roundedRect", radius: 0 },
      profile: { kind: "flat" },
      material: "matte",
      castsShadow: true,
      receivesShadow: true,
    },
    {
      id: "c",
      position: { x: 10, y: 160 },
      size: { x: 10, y: 10 },
      elevation: 0,
      thickness: 1,
      shape: { kind: "roundedRect", radius: 0 },
      profile: { kind: "flat" },
      material: "matte",
      castsShadow: false,
      receivesShadow: true,
    },
  ],
  light: { direction: { x: -0.6, y: -0.8, z: 1 }, intensity: 1 },
};

const BOUNDED_SHADOW = { maxDistance: 20, stepSize: 0.5, bias: 0.5 };

function tallScene(): Scene {
  return createScene({ ...TALL_SCENE });
}

function movedScene(offsetX = 2, offsetY = 1): Scene {
  return createScene({
    ...TALL_SCENE,
    surfaces: [
      {
        ...TALL_SCENE.surfaces![0]!,
        position: { x: 10 + offsetX, y: 10 + offsetY },
      },
      TALL_SCENE.surfaces![1]!,
      TALL_SCENE.surfaces![2]!,
    ],
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

function render(pipeline: GpuScenePipeline, scene: Scene, extra: Record<string, unknown> = {}) {
  return pipeline.render({
    scene,
    dpr: 1,
    shadowOptions: BOUNDED_SHADOW,
    tileSize: 32,
    ...extra,
  });
}

const WORKGROUP = 64;
const RENDER_WIDTH = 100;
const RENDER_HEIGHT = 200;
const TOTAL_TEXELS = RENDER_WIDTH * RENDER_HEIGHT;

/** Locate each pass's uniform write by its packed content signature. */
function uniformWrites(device: MockFullDevice) {
  const all = device.writes;
  const view = (w: { bytes: Uint8Array }) =>
    new DataView(w.bytes.buffer, w.bytes.byteOffset, w.bytes.byteLength);
  return {
    // 16 bytes, totalMaskCells 0 at 0, workgroupSize 64 at 4 (maskMeta is
    // all-zero except element 0 / candidate bin; lighting has the ambient
    // f32 at 0)
    height: all.filter(
      (w) =>
        w.bytes.byteLength === 16 &&
        view(w).getUint32(0, true) === 0 &&
        view(w).getUint32(4, true) === WORKGROUP,
    ),
    // #32 maskMeta: 16 bytes with the sentinel/count at 0 and NO
    // workgroupSize at 4 (the height uniform carries 64 there)
    maskMeta: all.filter(
      (w) => w.bytes.byteLength === 16 && view(w).getUint32(4, true) !== WORKGROUP,
    ),
    // 32 bytes, width 100 at 12, workgroupSize 64 at 20 (the presentation
    // uniform is also 32 bytes but carries composite bytes there)
    normal: all.filter(
      (w) =>
        w.bytes.byteLength === 32 &&
        view(w).getUint32(12, true) === RENDER_WIDTH &&
        view(w).getUint32(20, true) === WORKGROUP,
    ),
    // #43: 2144 bytes — 96 scalar/pad bytes + 8 kernel variants x 16 packed
    // vec4 cone directions
    shadow: all.filter((w) => w.bytes.byteLength === 96 + 8 * 16 * 16),
    // #43 reconstruction: 32 bytes, width 100 at 0, height 200 at 4, the f32
// height gate 0.5 at 20 and zeroed pads (distinct from the 32-byte
// presentation uniform whose shadowAlphaByte sits at 20; the normal
// uniform carries the render width at 12 instead)
    reconstruction: all.filter(
      (w) =>
        w.bytes.byteLength === 32 &&
        view(w).getUint32(0, true) === RENDER_WIDTH &&
        view(w).getUint32(4, true) === RENDER_HEIGHT &&
        view(w).getFloat32(20, true) === Math.fround(0.5) &&
        view(w).getUint32(24, true) === 0 &&
        view(w).getUint32(28, true) === 0,
    ),
    // 16 bytes with the ambient f32 at 0 and workgroupSize 64 at 4
    lighting: all.filter(
      (w) =>
        w.bytes.byteLength === 16 &&
        view(w).getUint32(0, true) !== 0 &&
        view(w).getUint32(4, true) === WORKGROUP,
    ),
  };
}

describe("GpuScenePipeline — #32 partial/full planning and band dispatch", () => {
  it("reports a full first-frame plan and full-chain dispatch with zeroed region pads", () => {
    const { device, pipeline } = setup();
    const stats = render(pipeline, tallScene());
    expect(stats.invalidation.reasons).toEqual(["first-frame"]);
    expect(stats.planning.mode).toBe("full");
    expect(stats.planning.reason).toBe("first-frame");
    expect(stats.planning.tileSize).toBe(32);
    expect(stats.planning.totalTileCount).toBe(Math.ceil(100 / 32) * Math.ceil(200 / 32));
    expect(stats.planning.dirtyTileCount).toBe(0);
    expect(stats.planning.dispatchTexels).toBe(TOTAL_TEXELS);
    expect(stats.planning.totalTexels).toBe(TOTAL_TEXELS);
    expect(stats.planning.planningHostMs).toBeGreaterThanOrEqual(0);
    // a full frame dispatches the full texel count in every compute stage
    expect(pipeline.getSnapshot().heightPass.lastDispatch.workgroupCountX).toBe(Math.ceil(TOTAL_TEXELS / WORKGROUP));
    expect(pipeline.getSnapshot().normalPass.lastDispatch.workgroupCountX).toBe(Math.ceil(TOTAL_TEXELS / WORKGROUP));
    expect(pipeline.getSnapshot().shadowPass.lastDispatch.workgroupCountX).toBe(Math.ceil(TOTAL_TEXELS / WORKGROUP));
    expect(pipeline.getSnapshot().lightingPass.lastDispatch.workgroupCountX).toBe(Math.ceil(TOTAL_TEXELS / WORKGROUP));
    // full-frame uniforms keep the historical zeroed pad bytes (the region
    // sentinel is regionEnd == 0; yOffset is also 0)
    const uniforms = uniformWrites(device);
    const normalView = new DataView(uniforms.normal.at(-1)!.bytes.buffer);
    expect(normalView.getUint32(24, true)).toBe(0); // yOffset
    expect(normalView.getUint32(28, true)).toBe(0); // regionEnd sentinel
    const shadowView = new DataView(uniforms.shadow.at(-1)!.bytes.buffer);
    expect(shadowView.getUint32(72, true)).toBe(0); // yOffset
    expect(shadowView.getUint32(76, true)).toBe(0); // regionEnd sentinel
  });

  it("chooses partial for a small local edit and dispatches only the band", () => {
    const { device, pipeline } = setup();
    render(pipeline, tallScene());
    const fullWorkgroups = Math.ceil(TOTAL_TEXELS / WORKGROUP);
    const firstSnapshot = pipeline.getSnapshot();
    const encodersBefore = device.encoders.length;
    const moved = movedScene();
    const stats = render(pipeline, moved);
    expect(stats.invalidation.reasons).toEqual(["scene"]);
    expect(stats.planning.mode).toBe("partial");
    const { y0, y1 } = stats.planning.band!;
    expect(stats.planning.dirtyTileCount).toBeGreaterThan(0);
    expect(stats.planning.dirtyTileCount).toBeLessThan(stats.planning.totalTileCount);
    expect(stats.planning.dirtyTexels).toBeGreaterThan(0);
    expect(stats.planning.candidateSurfaceCount).toBeGreaterThan(0);
    expect(
      stats.planning.candidateSurfaceCount + stats.planning.culledSurfaceCount,
    ).toBe(3);
    // the candidates are ACTUAL for the height stage: ORIGINAL surface
    // indices, unique, ascending, covering the whole dispatch band, and
    // genuinely packed into the reused maskMeta buffer for the compose
    // shaders (count at element 0, indices from element 1)
    expect(stats.planning.candidateIndices.length).toBe(stats.planning.candidateSurfaceCount);
    expect(stats.planning.candidateIndices).toEqual(
      [...stats.planning.candidateIndices].sort((a, b) => a - b),
    );
    const maskMetaView = new DataView(uniformWrites(device).maskMeta.at(-1)!.bytes.buffer);
    expect(maskMetaView.getUint32(0, true)).toBe(stats.planning.candidateSurfaceCount);
    for (let i = 0; i < stats.planning.candidateIndices.length; i++) {
      expect(maskMetaView.getUint32((1 + i) * 4, true)).toBe(stats.planning.candidateIndices[i]);
    }
    // the full frame's maskMeta carried the sentinel (identity iteration)
    const fullMeta = new DataView(uniformWrites(device).maskMeta[0].bytes.buffer);
    expect(fullMeta.getUint32(0, true)).toBe(MASK_META_FULL_SENTINEL);
    // the deterministic coverage threshold governs the decision
    expect(stats.planning.dispatchTexels).toBeLessThanOrEqual(
      stats.planning.totalTexels * PARTIAL_DISPATCH_RATIO,
    );
    // every compute stage dispatches ONLY the band rows (5 compose + 1 each
    // for normal, shadow, lighting; the SDF pass does not run mask-free)
    const bandTexels = RENDER_WIDTH * (y1 - y0 + 1);
    const bandWorkgroups = Math.ceil(bandTexels / WORKGROUP);
    expect(bandWorkgroups).toBeLessThan(fullWorkgroups);
    expect(pipeline.getSnapshot().heightPass.lastDispatch.workgroupCountX).toBe(bandWorkgroups);
    expect(pipeline.getSnapshot().normalPass.lastDispatch.workgroupCountX).toBe(bandWorkgroups);
    expect(pipeline.getSnapshot().shadowPass.lastDispatch.workgroupCountX).toBe(bandWorkgroups);
    expect(pipeline.getSnapshot().lightingPass.lastDispatch.workgroupCountX).toBe(bandWorkgroups);
    // the dispatch CALL count is unchanged (one call per pass) but every
    // call submits the SMALLER band workgroup count, provable on the mock
    expect(stats.frame.dispatchCount).toBe(8);
    const bandDispatches = device.encoders
      .slice(encodersBefore)
      .slice(0, 4) // height, normal, shadow, lighting (presentation has none)
      .flatMap((encoder) => encoder.log)
      .filter((entry) => entry.startsWith("dispatch("));
    expect(bandDispatches).toHaveLength(8);
    for (const entry of bandDispatches) {
      expect(entry).toBe(`dispatch(${bandWorkgroups})`);
    }
    // the band is threaded into every packed uniform
    const uniforms = uniformWrites(device);
    const heightView = new DataView(uniforms.height.at(-1)!.bytes.buffer);
    expect(heightView.getUint32(8, true)).toBe(y0 * RENDER_WIDTH);
    expect(heightView.getUint32(12, true)).toBe((y1 + 1) * RENDER_WIDTH);
    const normalView = new DataView(uniforms.normal.at(-1)!.bytes.buffer);
    expect(normalView.getUint32(24, true)).toBe(y0 * RENDER_WIDTH);
    expect(normalView.getUint32(28, true)).toBe((y1 + 1) * RENDER_WIDTH);
    const shadowView = new DataView(uniforms.shadow.at(-1)!.bytes.buffer);
    expect(shadowView.getUint32(72, true)).toBe(y0 * RENDER_WIDTH);
    expect(shadowView.getUint32(76, true)).toBe((y1 + 1) * RENDER_WIDTH);
    const lightingView = new DataView(uniforms.lighting.at(-1)!.bytes.buffer);
    expect(lightingView.getUint32(8, true)).toBe(y0 * RENDER_WIDTH);
    expect(lightingView.getUint32(12, true)).toBe((y1 + 1) * RENDER_WIDTH);
    // the partial frame still executes the full stage chain and shares ONE
    // fresh per-dispatch provenance token across every pass
    expect(stats.invalidation.executed).toHaveLength(7);
    const snapshot = pipeline.getSnapshot();
    expect(snapshot.heightPass.provenance).not.toBe(firstSnapshot.heightPass.provenance);
    expect(snapshot.normalPass.provenance).toBe(snapshot.heightPass.provenance);
    expect(snapshot.shadowPass.provenance).toBe(snapshot.heightPass.provenance);
    expect(snapshot.lightingPass.provenance).toBe(snapshot.heightPass.provenance);
    // the band matches the standalone planner on the exact same inputs
    const standalone = planPartialScene({
      prevBytes: encodeScene(tallScene(), 1).bytes,
      nextBytes: encodeScene(moved, 1).bytes,
      dpr: 1,
      renderWidth: RENDER_WIDTH,
      renderHeight: RENDER_HEIGHT,
      shadowOptions: BOUNDED_SHADOW,
      tileSize: 32,
    });
    expect(standalone.band).toEqual(stats.planning.band);
  });

  it("retains the same output allocations across a partial frame (nothing cleared)", () => {
    const { device, pipeline } = setup();
    render(pipeline, tallScene());
    const firstSnapshot = pipeline.getSnapshot();
    const allocationsAfterFull = device.created.length;
    const stats = render(pipeline, movedScene());
    expect(stats.planning.mode).toBe("partial");
    expect(stats.frame.newAllocations).toBe(0);
    expect(device.created.length).toBe(allocationsAfterFull);
    expect(stats.upload.bytesUploaded).toBeGreaterThan(0); // scene re-uploaded
    // the output buffers are the SAME GPU allocations (retention, not copies)
    const snapshot = pipeline.getSnapshot();
    expect(snapshot.lightingPass.color.buffer).toBe(firstSnapshot.lightingPass.color.buffer);
    expect(snapshot.heightPass.outputs.height.buffer).toBe(
      firstSnapshot.heightPass.outputs.height.buffer,
    );
    expect(snapshot.normalPass.output.buffer).toBe(firstSnapshot.normalPass.output.buffer);
    expect(snapshot.shadowPass.output.buffer).toBe(firstSnapshot.shadowPass.output.buffer);
  });

  it("chooses full when a broad/fragmented edit exceeds the coverage threshold", () => {
    const { pipeline } = setup();
    render(pipeline, tallScene());
    const broad = createScene({
      ...TALL_SCENE,
      surfaces: [
        { ...TALL_SCENE.surfaces![0]!, position: { x: 60, y: 120 } },
        { ...TALL_SCENE.surfaces![1]!, position: { x: 10, y: 10 } },
        TALL_SCENE.surfaces![2]!,
      ],
    });
    const stats = render(pipeline, broad);
    expect(stats.planning.mode).toBe("full");
    expect(stats.planning.reason).toContain("band-coverage");
    expect(stats.planning.band).toBeNull();
    // the diagnostics still report the region that would have been dirty
    expect(stats.planning.dirtyTexels).toBeGreaterThan(0);
    expect(pipeline.getSnapshot().heightPass.lastDispatch.workgroupCountX).toBe(Math.ceil(TOTAL_TEXELS / WORKGROUP));
  });

  it("falls back to full for light/material/viewport and option-with-scene changes", () => {
    // a fresh pipeline per fallback so each exact diff isolates exactly one
    // reason (successive frames would differ in multiple global fields)
    const lightPipeline = setup();
    render(lightPipeline.pipeline, tallScene());
    const light = createScene({ ...TALL_SCENE, light: { direction: { x: 0, y: 0, z: 1 } } });
    expect(render(lightPipeline.pipeline, light).planning.reason).toBe("light-direction-change");

    const materialPipeline = setup();
    render(materialPipeline.pipeline, tallScene());
    const material = createScene({
      ...TALL_SCENE,
      materials: { matte: { baseColor: { r: 1, g: 0, b: 0 }, roughness: 0.5, metallic: 0 } },
    });
    expect(render(materialPipeline.pipeline, material).planning.reason).toBe("material-values-change");

    const viewportPipeline = setup();
    render(viewportPipeline.pipeline, tallScene());
    const viewport = createScene({ ...TALL_SCENE, width: 120, height: 200 });
    expect(render(viewportPipeline.pipeline, viewport).planning.reason).toBe("viewport-change");

    // a scene change mixed with a pass-option change cannot prove locality
    const optionPipeline = setup();
    render(optionPipeline.pipeline, tallScene());
    const optionStats = render(optionPipeline.pipeline, movedScene(), {
      normalOptions: { scaleX: 0.9 },
    });
    expect(optionStats.invalidation.reasons).toEqual(["scene", "normal-options"]);
    expect(optionStats.planning.reason).toBe("option-change-with-scene");
    expect(optionStats.planning.mode).toBe("full");
    // a pure pass-option change never plans a partial
    const pure = render(optionPipeline.pipeline, movedScene(), { normalOptions: { scaleX: 0.4 } });
    expect(pure.invalidation.reasons).toEqual(["normal-options"]);
    expect(pure.planning.reason).toBe("no-scene-change");
    // an unchanged frame reports the default plan diagnostics
    const retained = render(optionPipeline.pipeline, movedScene(), {
      normalOptions: { scaleX: 0.4 },
    });
    expect(retained.invalidation.retained).toBe(true);
    expect(retained.planning.reason).toBe("no-scene-change");
  });

  it("never plans partial for a geometry + material-value change (surfaceCount changed, materialCount unchanged)", () => {
    // THE #43 review bug: an added surface shifts the material table offset,
    // and a simultaneous material table VALUE change is a frame-global
    // lighting semantic — a partial band would light the dirty region with
    // the NEW material and the retained region with the OLD one.
    const baseScene = createScene({
      width: 100,
      height: 200,
      surfaces: [
        {
          id: "panel",
          position: { x: 0, y: 0 },
          size: { x: 100, y: 200 },
          elevation: 0,
          thickness: 0,
          shape: { kind: "roundedRect", radius: 0 },
          profile: { kind: "flat" },
          material: "matte",
          castsShadow: false,
          receivesShadow: true,
        },
        {
          id: "btn",
          position: { x: 10, y: 10 },
          size: { x: 30, y: 30 },
          elevation: 2,
          thickness: 2,
          shape: { kind: "roundedRect", radius: 0 },
          profile: { kind: "flat" },
          material: "matte",
          castsShadow: true,
          receivesShadow: true,
        },
      ],
      materials: { matte: { baseColor: { r: 0.5, g: 0.5, b: 0.5 }, roughness: 0.5, metallic: 0 } },
      light: { direction: { x: -0.6, y: -0.8, z: 1 }, intensity: 1 },
    });
    const edited = createScene({
      ...baseScene,
      surfaces: [
        ...baseScene.surfaces,
        {
          id: "chip",
          position: { x: 80, y: 170 },
          size: { x: 6, y: 6 },
          elevation: 1,
          thickness: 1,
          shape: { kind: "roundedRect", radius: 0 },
          profile: { kind: "flat" },
          material: "matte",
          castsShadow: true,
          receivesShadow: true,
        },
      ],
      // the EXISTING matte definition changes: materialCount unchanged
      materials: { matte: { baseColor: { r: 1, g: 0, b: 0 }, roughness: 0.5, metallic: 0 } },
    });
    const { pipeline } = setup();
    pipeline.render({ scene: baseScene, dpr: 1, shadowOptions: BOUNDED_SHADOW, tileSize: 32 });
    const stats = pipeline.render({ scene: edited, dpr: 1, shadowOptions: BOUNDED_SHADOW, tileSize: 32 });
    expect(stats.invalidation.reasons).toEqual(["scene", "material-values"]);
    expect(stats.planning.mode).toBe("full");
    expect(stats.planning.reason).toBe("material-values-change");
  });

  it("keeps partial eligibility when the surfaceCount changes but the material table is byte-identical", () => {
    const baseScene = createScene({
      width: 100,
      height: 200,
      surfaces: [
        {
          id: "panel",
          position: { x: 0, y: 0 },
          size: { x: 100, y: 200 },
          elevation: 0,
          thickness: 0,
          shape: { kind: "roundedRect", radius: 0 },
          profile: { kind: "flat" },
          material: "matte",
          castsShadow: false,
          receivesShadow: true,
        },
        {
          id: "btn",
          position: { x: 10, y: 10 },
          size: { x: 30, y: 30 },
          elevation: 2,
          thickness: 2,
          shape: { kind: "roundedRect", radius: 0 },
          profile: { kind: "flat" },
          material: "matte",
          castsShadow: true,
          receivesShadow: true,
        },
      ],
      materials: { matte: { baseColor: { r: 0.5, g: 0.5, b: 0.5 }, roughness: 0.5, metallic: 0 } },
      light: { direction: { x: -0.6, y: -0.8, z: 1 }, intensity: 1 },
    });
    const edited = createScene({
      ...baseScene,
      surfaces: [
        ...baseScene.surfaces,
        {
          id: "chip",
          position: { x: 80, y: 170 },
          size: { x: 6, y: 6 },
          elevation: 1,
          thickness: 1,
          shape: { kind: "roundedRect", radius: 0 },
          profile: { kind: "flat" },
          material: "matte",
          castsShadow: true,
          receivesShadow: true,
        },
      ],
    });
    const { pipeline } = setup();
    pipeline.render({ scene: baseScene, dpr: 1, shadowOptions: BOUNDED_SHADOW, tileSize: 32 });
    const stats = pipeline.render({ scene: edited, dpr: 1, shadowOptions: BOUNDED_SHADOW, tileSize: 32 });
    // material table bytes identical -> geometry-only partial eligibility
    expect(stats.invalidation.reasons).toEqual(["scene"]);
    expect(stats.invalidation.reasons).not.toContain("material-values");
    expect(stats.planning.mode).toBe("partial");
  });

  it("invalidates retained regional state when a partial frame fails mid-chain", () => {
    const { device, pipeline } = setup();
    render(pipeline, tallScene());
    device.failNextEncoder = true;
    expect(() => render(pipeline, movedScene())).toThrow(/injected encoder failure/);
    expect(() => pipeline.getSnapshot()).toThrow(/no frame rendered/);
    // the next frame recomputes conservatively from the full chain (no
    // retained regional state is trusted)
    const recovered = render(pipeline, movedScene());
    expect(recovered.invalidation.reasons).toEqual(["first-frame"]);
    expect(recovered.planning.reason).toBe("first-frame");
    expect(recovered.planning.mode).toBe("full");
    expect(pipeline.getSnapshot().heightPass.lastDispatch.workgroupCountX).toBe(
      Math.ceil(TOTAL_TEXELS / WORKGROUP),
    );
  });

  it("never trusts the scene fingerprint alone for skip/partial decisions", () => {
    const { device, pipeline } = setup();
    render(pipeline, tallScene());
    // Forge a hash collision: overwrite the retained frame's scene
    // fingerprint with the fingerprint of the NEXT frame while the retained
    // bytes are still the previous scene. Without exact-byte authorization
    // this frame would be reported as fully retained and skip the upload;
    // the exact comparison must force a conservative full recompute.
    const moved = movedScene();
    const forgedKey: FrameKey = {
      ...(pipeline as unknown as { lastKey: FrameKey }).lastKey!,
      scene: computeFrameKey(encodeScene(moved, 1), { dpr: 1 }).scene,
    };
    (pipeline as unknown as { lastKey: FrameKey | null }).lastKey = forgedKey;
    const writesBefore = device.writes.length;
    const stats = render(pipeline, moved);
    expect(stats.invalidation.reasons).toEqual(["first-frame"]);
    expect(stats.planning.reason).toBe("first-frame");
    expect(stats.upload.bytesUploaded).toBeGreaterThan(0);
    expect(device.writes.length).toBeGreaterThan(writesBefore);
    expect(pipeline.getSnapshot().heightPass.lastDispatch.workgroupCountX).toBe(
      Math.ceil(TOTAL_TEXELS / WORKGROUP),
    );
  });

  it("handles a zero-candidate partial band: the compose clears it with count 0", () => {
    // surfaces: a (silicone top), d (matte top anchor), b + c (lower,
    // deleted). The anchor keeps the material table stable; deleting b and c
    // leaves a dirty band with NO remaining surface footprint.
    const zeroBase = createScene({
      width: 100,
      height: 200,
      surfaces: [
        { id: "a", position: { x: 10, y: 10 }, size: { x: 40, y: 30 }, elevation: 2, thickness: 2, shape: { kind: "roundedRect", radius: 0 }, profile: { kind: "flat" }, material: "silicone", castsShadow: true, receivesShadow: true },
        { id: "d", position: { x: 80, y: 20 }, size: { x: 10, y: 10 }, elevation: 0, thickness: 1, shape: { kind: "roundedRect", radius: 0 }, profile: { kind: "flat" }, material: "matte", castsShadow: false, receivesShadow: true },
        { id: "b", position: { x: 60, y: 140 }, size: { x: 20, y: 20 }, elevation: 1, thickness: 1, shape: { kind: "roundedRect", radius: 0 }, profile: { kind: "flat" }, material: "matte", castsShadow: true, receivesShadow: true },
        { id: "c", position: { x: 10, y: 160 }, size: { x: 10, y: 10 }, elevation: 0, thickness: 1, shape: { kind: "roundedRect", radius: 0 }, profile: { kind: "flat" }, material: "matte", castsShadow: false, receivesShadow: true },
      ],
      light: { direction: { x: -0.6, y: -0.8, z: 1 }, intensity: 1 },
    });
    const zeroOptions = { maxDistance: 15, stepSize: 0.5, bias: 0.5 };
    const { device, pipeline } = setup();
    pipeline.render({ scene: zeroBase, dpr: 1, shadowOptions: zeroOptions, tileSize: 32 });
    const edited = createScene({
      ...zeroBase,
      surfaces: [zeroBase.surfaces[0], zeroBase.surfaces[1]],
    });
    const stats = pipeline.render({ scene: edited, dpr: 1, shadowOptions: zeroOptions, tileSize: 32 });
    expect(stats.planning.mode).toBe("partial");
    expect(stats.planning.candidateIndices).toEqual([]);
    expect(stats.planning.candidateSurfaceCount).toBe(0);
    expect(stats.planning.culledSurfaceCount).toBe(2);
    // the height pass still dispatches the band with a ZERO-count bin: the
    // compose shaders write cleared/background outputs without iterating
    expect(pipeline.getSnapshot().heightPass.lastDispatch.workgroupCountX).toBeLessThan(
      Math.ceil(TOTAL_TEXELS / WORKGROUP),
    );
    const maskMetaView = new DataView(uniformWrites(device).maskMeta.at(-1)!.bytes.buffer);
    expect(maskMetaView.getUint32(0, true)).toBe(0);
  });
});

describe("GpuScenePipeline — #43 reconstruction halo propagation on partial frames", () => {
  // A soft + reconstruction variant of the tall scene: the reconstruction
  // filter's texel radius must expand the region lighting (and normal, and
  // the filter itself) recompute, so a partial geometry update never leaves
  // stale color in the reconstruction halo.
  const SOFT_RECON_SHADOW = {
    ...BOUNDED_SHADOW,
    samples: 8 as const,
    reconstruction: { enabled: true, radius: 2 },
  };
  const RADIUS_TEXELS = 2;

  function softTallScene(angularRadius = Math.fround(0.2)): Scene {
    return createScene({
      ...TALL_SCENE,
      light: { direction: { x: -0.6, y: -0.8, z: 1 }, intensity: 1, angularRadius },
    });
  }

  function renderSoft(pipeline: GpuScenePipeline, scene: Scene) {
    return pipeline.render({
      scene,
      dpr: 1,
      shadowOptions: SOFT_RECON_SHADOW,
      tileSize: 32,
    });
  }

  it("propagates the reconstruction halo to normal/reconstruction/lighting on a partial frame", () => {
    const { device, pipeline } = setup();
    renderSoft(pipeline, softTallScene());
    const moved = createScene({
      ...TALL_SCENE,
      light: { direction: { x: -0.6, y: -0.8, z: 1 }, intensity: 1, angularRadius: Math.fround(0.2) },
      surfaces: [
        { ...TALL_SCENE.surfaces![0]!, position: { x: 12, y: 11 } },
        TALL_SCENE.surfaces![1]!,
        TALL_SCENE.surfaces![2]!,
      ],
    });
    const stats = renderSoft(pipeline, moved);
    expect(stats.planning.mode).toBe("partial");
    expect(stats.reconstructionActive).toBe(true);
    const { y0, y1 } = stats.planning.band!;
    const haloY0 = Math.max(0, y0 - RADIUS_TEXELS);
    const haloY1 = Math.min(RENDER_HEIGHT - 1, y1 + RADIUS_TEXELS);
    const uniforms = uniformWrites(device);
    // height + shadow recompute ONLY the original band...
    const heightView = new DataView(uniforms.height.at(-1)!.bytes.buffer);
    expect(heightView.getUint32(8, true)).toBe(y0 * RENDER_WIDTH);
    expect(heightView.getUint32(12, true)).toBe((y1 + 1) * RENDER_WIDTH);
    const shadowView = new DataView(uniforms.shadow.at(-1)!.bytes.buffer);
    expect(shadowView.getUint32(72, true)).toBe(y0 * RENDER_WIDTH);
    expect(shadowView.getUint32(76, true)).toBe((y1 + 1) * RENDER_WIDTH);
    // ...while the reconstruction filter, its normal guidance and the
    // lighting that consumes it recompute the band EXPANDED by the radius
    const reconView = new DataView(uniforms.reconstruction.at(-1)!.bytes.buffer);
    expect(reconView.getUint32(12, true)).toBe(haloY0 * RENDER_WIDTH);
    expect(reconView.getUint32(16, true)).toBe((haloY1 + 1) * RENDER_WIDTH);
    const normalView = new DataView(uniforms.normal.at(-1)!.bytes.buffer);
    expect(normalView.getUint32(24, true)).toBe(haloY0 * RENDER_WIDTH);
    expect(normalView.getUint32(28, true)).toBe((haloY1 + 1) * RENDER_WIDTH);
    const lightingView = new DataView(uniforms.lighting.at(-1)!.bytes.buffer);
    expect(lightingView.getUint32(8, true)).toBe(haloY0 * RENDER_WIDTH);
    expect(lightingView.getUint32(12, true)).toBe((haloY1 + 1) * RENDER_WIDTH);
    // the reconstruction pass genuinely ran on the expanded band
    expect(pipeline.getSnapshot().reconstructionPass).not.toBeNull();
    expect(pipeline.getSnapshot().reconstructionPass!.lastDispatch.radiusTexels).toBe(
      RADIUS_TEXELS,
    );
  });

  it("keeps the historical band for normal/lighting on a partial frame when reconstruction is disabled", () => {
    const { device, pipeline } = setup();
    const shadowOptions = { ...BOUNDED_SHADOW, samples: 8 as const, reconstruction: { enabled: false } };
    const renderDisabled = (scene: Scene) =>
      pipeline.render({ scene, dpr: 1, shadowOptions, tileSize: 32 });
    renderDisabled(softTallScene());
    const moved = createScene({
      ...TALL_SCENE,
      light: { direction: { x: -0.6, y: -0.8, z: 1 }, intensity: 1, angularRadius: Math.fround(0.2) },
      surfaces: [{ ...TALL_SCENE.surfaces![0]!, position: { x: 12, y: 11 } }, TALL_SCENE.surfaces![1]!, TALL_SCENE.surfaces![2]!],
    });
    const stats = renderDisabled(moved);
    expect(stats.planning.mode).toBe("partial");
    expect(stats.reconstructionActive).toBe(false);
    const { y0, y1 } = stats.planning.band!;
    const uniforms = uniformWrites(device);
    const normalView = new DataView(uniforms.normal.at(-1)!.bytes.buffer);
    expect(normalView.getUint32(24, true)).toBe(y0 * RENDER_WIDTH);
    expect(normalView.getUint32(28, true)).toBe((y1 + 1) * RENDER_WIDTH);
    const lightingView = new DataView(uniforms.lighting.at(-1)!.bytes.buffer);
    expect(lightingView.getUint32(8, true)).toBe(y0 * RENDER_WIDTH);
    expect(lightingView.getUint32(12, true)).toBe((y1 + 1) * RENDER_WIDTH);
    // no reconstruction pass was dispatched
    expect(uniforms.reconstruction).toHaveLength(0);
  });
});

describe("GpuScenePipeline — #43 geometry + global option change is NEVER partial", () => {
  // The partial-locality proof only holds while the global shadow /
  // reconstruction semantics are identical to the retained frame. A small
  // geometry edit combined with a global semantic change must therefore
  // plan FULL ("option-change-with-scene" / "<semantic>-change"), never
  // partial — otherwise the dirty band would use the NEW semantics while
  // the retained region keeps the OLD ones (mixed-semantic frame).

  const SOFT_OPTIONS_A = {
    ...BOUNDED_SHADOW,
    samples: 4 as const,
    reconstruction: { enabled: true, radius: 2 },
  };
  const SOFT_OPTIONS_B = {
    ...BOUNDED_SHADOW,
    samples: 16 as const,
    reconstruction: { enabled: true, radius: 4 },
  };

  function softTall(angularRadius = Math.fround(0.2)): Scene {
    return createScene({
      ...TALL_SCENE,
      light: { direction: { x: -0.6, y: -0.8, z: 1 }, intensity: 1, angularRadius },
    });
  }

  it("geometry + samples/radius change plans full (option-change-with-scene)", () => {
    const { pipeline } = setup();
    pipeline.render({ scene: softTall(), dpr: 1, shadowOptions: SOFT_OPTIONS_A, tileSize: 32 });
    const moved = createScene({
      ...TALL_SCENE,
      light: { direction: { x: -0.6, y: -0.8, z: 1 }, intensity: 1, angularRadius: Math.fround(0.2) },
      surfaces: [{ ...TALL_SCENE.surfaces![0]!, position: { x: 12, y: 11 } }, TALL_SCENE.surfaces![1]!, TALL_SCENE.surfaces![2]!],
    });
    const stats = pipeline.render({ scene: moved, dpr: 1, shadowOptions: SOFT_OPTIONS_B, tileSize: 32 });
    expect(stats.invalidation.reasons).toEqual(["scene", "shadow-options", "reconstruction-options"]);
    expect(stats.planning.mode).toBe("full");
    expect(stats.planning.reason).toBe("option-change-with-scene");
    // the full chain ran with the NEW options everywhere
    expect(stats.reconstructionActive).toBe(true);
    expect(pipeline.getSnapshot().reconstructionPass!.options.radiusTexels).toBe(4);
  });

  it("geometry + angularRadius change plans full (<semantic>-change)", () => {
    const { pipeline } = setup();
    pipeline.render({ scene: softTall(Math.fround(0.1)), dpr: 1, shadowOptions: SOFT_OPTIONS_A, tileSize: 32 });
    const moved = createScene({
      ...TALL_SCENE,
      light: { direction: { x: -0.6, y: -0.8, z: 1 }, intensity: 1, angularRadius: Math.fround(0.2) },
      surfaces: [{ ...TALL_SCENE.surfaces![0]!, position: { x: 12, y: 11 } }, TALL_SCENE.surfaces![1]!, TALL_SCENE.surfaces![2]!],
    });
    const stats = pipeline.render({ scene: moved, dpr: 1, shadowOptions: SOFT_OPTIONS_A, tileSize: 32 });
    expect(stats.invalidation.reasons).toContain("scene");
    expect(stats.invalidation.reasons).toContain("light-angular-radius");
    expect(stats.planning.mode).toBe("full");
    expect(stats.planning.reason).toBe("light-angular-radius-change");
  });

  it("geometry + reconstruction disabled plans full (no stale reconstructed field outside the band)", () => {
    const { pipeline } = setup();
    pipeline.render({ scene: softTall(), dpr: 1, shadowOptions: SOFT_OPTIONS_A, tileSize: 32 });
    const moved = createScene({
      ...TALL_SCENE,
      light: { direction: { x: -0.6, y: -0.8, z: 1 }, intensity: 1, angularRadius: Math.fround(0.2) },
      surfaces: [{ ...TALL_SCENE.surfaces![0]!, position: { x: 12, y: 11 } }, TALL_SCENE.surfaces![1]!, TALL_SCENE.surfaces![2]!],
    });
    const disabledOpts = { ...BOUNDED_SHADOW, samples: 8 as const, reconstruction: { enabled: false } };
    const stats = pipeline.render({ scene: moved, dpr: 1, shadowOptions: disabledOpts, tileSize: 32 });
    expect(stats.invalidation.reasons).toContain("scene");
    expect(stats.invalidation.reasons).toContain("reconstruction-options");
    expect(stats.planning.mode).toBe("full");
    expect(stats.planning.reason).toBe("option-change-with-scene");
    // reconstruction bypassed everywhere: raw visibility consumed
    expect(stats.reconstructionActive).toBe(false);
    expect(pipeline.getSnapshot().reconstructionPass).toBeNull();
  });

  it("geometry + hard<->soft transitions plan full in both directions", () => {
    // soft -> hard (angularRadius 0)
    {
      const { pipeline } = setup();
      pipeline.render({ scene: softTall(), dpr: 1, shadowOptions: SOFT_OPTIONS_A, tileSize: 32 });
      const moved = createScene({
        ...TALL_SCENE,
        light: { direction: { x: -0.6, y: -0.8, z: 1 }, intensity: 1, angularRadius: 0 },
        surfaces: [{ ...TALL_SCENE.surfaces![0]!, position: { x: 12, y: 11 } }, TALL_SCENE.surfaces![1]!, TALL_SCENE.surfaces![2]!],
      });
      const stats = pipeline.render({ scene: moved, dpr: 1, shadowOptions: SOFT_OPTIONS_A, tileSize: 32 });
      expect(stats.invalidation.reasons).toContain("scene");
      expect(stats.invalidation.reasons).toContain("light-angular-radius");
      expect(stats.planning.mode).toBe("full");
      expect(stats.reconstructionActive).toBe(false);
    }
    // hard -> soft (samples 1 -> 8 with geometry)
    {
      const { pipeline } = setup();
      const hardOpts = { ...BOUNDED_SHADOW, samples: 1 as const, reconstruction: { enabled: true, radius: 2 } };
      pipeline.render({ scene: tallScene(), dpr: 1, shadowOptions: hardOpts, tileSize: 32 });
      const moved = createScene({
        ...TALL_SCENE,
        light: { direction: { x: -0.6, y: -0.8, z: 1 }, intensity: 1, angularRadius: Math.fround(0.2) },
        surfaces: [{ ...TALL_SCENE.surfaces![0]!, position: { x: 12, y: 11 } }, TALL_SCENE.surfaces![1]!, TALL_SCENE.surfaces![2]!],
      });
      const stats = pipeline.render({ scene: moved, dpr: 1, shadowOptions: SOFT_OPTIONS_A, tileSize: 32 });
      expect(stats.invalidation.reasons).toContain("scene");
      expect(stats.invalidation.reasons).toContain("shadow-options");
      expect(stats.planning.mode).toBe("full");
      expect(stats.reconstructionActive).toBe(true);
    }
  });
});

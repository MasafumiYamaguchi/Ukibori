import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GpuBindGroupEntryLike,
  GpuBindGroupLayoutEntryLike,
  GpuBindGroupLayoutLike,
  GpuBindGroupLike,
  GpuBufferLike,
  GpuCanvasConfigurationLike,
  GpuCanvasContextLike,
  GpuComputePipelineLike,
  GpuLimitsLike,
  GpuPipelineDeviceLike,
  GpuPipelineLayoutLike,
  GpuPresentationLimitsLike,
  GpuRenderPassEncoderLike,
  GpuShaderModuleLike,
  GpuTextureLike,
} from "ukibori-renderer";
import { UkiboriDom } from "./dom-layer";
import type { DomGpuSource } from "./dom-layer";
import { OverlayCanvas } from "./overlay";

// ---------------------------------------------------------------------------
// Full structural WebGPU mock (the GpuScenePipeline harness pattern): the
// exact GpuPipelineDeviceLike + GpuCanvasContextLike surfaces, with a real
// HTMLCanvasElement as the context's backing store so the dom-layer's
// overlay ownership contract is exercised end to end.
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
  setBindGroup(): void {
    this.log.push("setBindGroup");
  }
  draw(): void {
    this.log.push("draw");
  }
  end(): void {
    this.log.push("end");
  }
}

class MockFullEncoder {
  readonly log: string[] = [];
  beginComputePass(): {
    setPipeline(): void;
    setBindGroup(): void;
    dispatchWorkgroups(): void;
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
      dispatchWorkgroups(): void {
        log.push("dispatch");
      },
      end(): void {
        log.push("end");
      },
    };
  }
  beginRenderPass(): GpuRenderPassEncoderLike {
    const pass = new MockRenderPass();
    this.log.push("beginRenderPass");
    return pass;
  }
  finish(): { label?: string } {
    return { label: "mock" };
  }
}

class MockGpuContext implements GpuCanvasContextLike {
  readonly canvas: HTMLCanvasElement;
  readonly configured: GpuCanvasConfigurationLike[] = [];
  unconfigured = false;
  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
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
  /** one-shot: the next createCommandEncoder call throws (mid-frame failure injection) */
  failNextEncoder = false;
  destroyed = false;
  private resolveLost!: (value: unknown) => void;
  readonly lost: Promise<unknown>;

  constructor() {
    this.limits = {
      maxStorageBufferBindingSize: 1 << 28,
      maxBufferSize: 1 << 28,
      maxUniformBufferBindingSize: 16 * 1024,
      maxComputeWorkgroupSizeX: 256,
      maxComputeInvocationsPerWorkgroup: 256,
      maxComputeWorkgroupsPerDimension: 65535,
      maxStorageBuffersPerShaderStage: 8,
    };
    this.lost = new Promise((resolveLost) => {
      this.resolveLost = resolveLost;
    });
  }

  triggerLoss(): void {
    this.resolveLost(undefined);
  }

  destroy(): void {
    this.destroyed = true;
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

  createRenderPipeline(desc: { label?: string }): GpuRenderPassEncoderLike {
    return { label: desc.label } as unknown as GpuRenderPassEncoderLike;
  }

  createBindGroupLayout(desc: {
    label?: string;
    entries: readonly GpuBindGroupLayoutEntryLike[];
  }): GpuBindGroupLayoutLike {
    return { label: desc.label };
  }

  createPipelineLayout(desc: { label?: string; bindGroupLayouts: readonly GpuBindGroupLayoutLike[] }): GpuPipelineLayoutLike {
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
// DOM + context stubs
// ---------------------------------------------------------------------------

interface Recording2dContext {
  putImageDataCalls: number;
  clearRectCalls: number;
}

/** Stub HTMLCanvasElement.getContext: "webgpu" -> one MockGpuContext per
 * canvas; "2d" -> a recording context (CPU paint bookkeeping). */
function stubGetContext() {
  if (typeof (globalThis as { ImageData?: unknown }).ImageData === "undefined") {
    (globalThis as { ImageData: unknown }).ImageData = class {
      data: Uint8ClampedArray;
      width: number;
      height: number;
      constructor(data: Uint8ClampedArray, width: number, height: number) {
        this.data = data;
        this.width = width;
        this.height = height;
      }
    };
  }
  const contexts = new Map<HTMLCanvasElement, MockGpuContext>();
  const contextRequests: Array<{ canvas: HTMLCanvasElement; type: string }> = [];
  const recording = { putImageDataCalls: 0, clearRectCalls: 0 };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    (function (
      this: HTMLCanvasElement,
      ...args: unknown[]
    ): unknown {
      const type = String(args[0]);
      const canvas = this;
      contextRequests.push({ canvas, type });
      if (type === "webgpu") {
        let context = contexts.get(canvas);
        if (context === undefined) {
          context = new MockGpuContext(canvas);
          contexts.set(canvas, context);
        }
        return context;
      }
      if (type === "2d") {
        return {
          putImageData: () => {
            recording.putImageDataCalls++;
          },
          clearRect: () => {
            recording.clearRectCalls++;
          },
        };
      }
      return null;
    }) as unknown as typeof HTMLCanvasElement.prototype.getContext,
  );
  return { contexts, contextRequests, recording };
}

function stubRectFor(el: Element, rect: { left: number; top: number; width: number; height: number }) {
  const domRect = {
    ...rect,
    x: rect.left,
    y: rect.top,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
  } as DOMRect;
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue(domRect);
}

const BUTTON_OPTIONS = {
  id: "primary",
  shape: { kind: "roundedRect", radius: 10 } as const,
  elevation: 4,
  thickness: 2,
  bevelWidth: 3,
  material: "silicone",
};

let host: HTMLDivElement;
let button: HTMLButtonElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  button = document.createElement("button");
  button.type = "button";
  button.setAttribute("aria-label", "Primary action");
  button.textContent = "Press me";
  host.appendChild(button);
  stubRectFor(button, { left: 100, top: 200, width: 160, height: 44 });
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function makeSeam(device: MockFullDevice): DomGpuSource {
  return {
    async requestAdapter() {
      return {
        async requestDevice() {
          return device as unknown as GpuPipelineDeviceLike;
        },
      };
    },
    getPreferredCanvasFormat() {
      return "rgba8unorm";
    },
  };
}

describe("UkiboriDom — async WebGPU backend (auto/cpu/webgpu)", () => {
  it("requests optional timestamp-query when advertised without making it mandatory", async () => {
    stubGetContext();
    const device = new MockFullDevice();
    const requestDevice = vi.fn(async (_descriptor?: { requiredFeatures?: readonly string[] }) =>
      device as unknown as GpuPipelineDeviceLike,
    );
    const layer = await UkiboriDom.create({
      backend: "auto",
      gpu: {
        requestAdapter: async () => ({
          features: { has: (feature) => feature === "timestamp-query" },
          requestDevice,
        }),
        getPreferredCanvasFormat: () => "rgba8unorm",
      },
      schedule: (cb) => cb(),
      observe: false,
    });

    expect(requestDevice).toHaveBeenCalledWith({ requiredFeatures: ["timestamp-query"] });
    expect(layer.debugState().backend).toBe("webgpu");
    layer.dispose();
  });

  it("auto acquires a real adapter surface and presents directly to the WebGPU canvas", async () => {
    const stub = stubGetContext();
    const device = new MockFullDevice();
    const layer = await UkiboriDom.create({
      backend: "auto",
      gpu: makeSeam(device),
      schedule: (cb) => cb(),
      observe: false,
    });
    layer.register(button, BUTTON_OPTIONS);
    layer.render();

    const state = layer.debugState();
    expect(state.backend).toBe("webgpu");
    expect(state.gpuFallbackReason).toBeNull();
    // Honest last-frame host stats: structured pipeline stats + host render ms.
    expect(state.gpuFrame).not.toBeNull();
    expect(state.gpuFrame!.frame.renderWidth).toBe(288);
    expect(state.gpuFrame!.frame.renderHeight).toBe(172);
    expect(state.gpuFrame!.frame.upload.bytesUploaded).toBeGreaterThan(0);
    expect(state.gpuFrame!.frame.frame.submissions).toBe(5);
    expect(state.gpuFrame!.hostRenderMs).toBeGreaterThanOrEqual(0);
    expect(state.renderSize).toEqual({ width: 288, height: 172 });

    // The full #31 chain ran: 5 queue submissions (height/normal/shadow/
    // lighting/presentation), the canvas was configured for direct
    // presentation, and the backing store matches the render extent.
    expect(device.encoders).toHaveLength(5);
    expect(device.submits).toHaveLength(5);
    const context = [...stub.contexts.values()][0];
    expect(context.configured).toHaveLength(1);
    expect(context.configured[0].format).toBe("rgba8unorm");
    expect(context.configured[0].alphaMode).toBe("premultiplied");
    expect(context.canvas.width).toBe(288);
    expect(context.canvas.height).toBe(172);

    // NO readback and NO 2D copy on the GPU path.
    expect(stub.recording.putImageDataCalls).toBe(0);
    expect(layer.debugBuffers()).toBeNull();
    expect(layer.debugObjectId()).toBeNull();

    // Overlay ownership: the WebGPU canvas is the ACTIVE canvas; the
    // retained CPU canvas exists but is hidden.
    const overlay = (layer as unknown as { overlay: OverlayCanvas }).overlay;
    expect(overlay.activeBackend).toBe("webgpu");
    expect(overlay.node).toBe(overlay.gpuCanvas());
    expect(overlay.canvas.style.display).toBe("none");
    expect(overlay.gpuCanvas().style.display).toBe("");
    layer.dispose();
  });

  it("explicit cpu never touches the GPU source and keeps the CPU debug buffers", async () => {
    const stub = stubGetContext();
    const adapterSpy = vi.fn(async () => null);
    const layer = await UkiboriDom.create({
      backend: "cpu",
      gpu: { requestAdapter: adapterSpy, getPreferredCanvasFormat: () => "rgba8unorm" },
      schedule: (cb) => cb(),
      observe: false,
    });
    layer.register(button, BUTTON_OPTIONS);
    layer.render();

    expect(adapterSpy).not.toHaveBeenCalled();
    expect(layer.debugState().backend).toBe("cpu");
    expect(layer.debugState().gpuFallbackReason).toBeNull();
    expect(layer.debugState().gpuFrame).toBeNull();
    // CPU path: one putImageData, host debug buffers available.
    expect(stub.recording.putImageDataCalls).toBe(1);
    expect(layer.debugBuffers()).not.toBeNull();
    layer.dispose();
  });

  it("auto falls back to CPU when no WebGPU adapter is available", async () => {
    const stub = stubGetContext();
    const layer = await UkiboriDom.create({
      backend: "auto",
      gpu: { requestAdapter: async () => null, getPreferredCanvasFormat: () => "rgba8unorm" },
      schedule: (cb) => cb(),
      observe: false,
    });
    layer.register(button, BUTTON_OPTIONS);
    layer.render();

    expect(layer.debugState().backend).toBe("cpu");
    expect(layer.debugState().gpuFallbackReason).toContain("adapter");
    expect(layer.debugState().gpuFrame).toBeNull();
    expect(stub.recording.putImageDataCalls).toBe(1);
    // No GPU canvas was ever created: only the CPU canvas exists.
    expect(document.querySelectorAll("canvas")).toHaveLength(1);
    layer.dispose();
  });

  it("auto falls back to CPU when adapter/device initialization throws", async () => {
    const stub = stubGetContext();
    const layer = await UkiboriDom.create({
      backend: "auto",
      gpu: {
        requestAdapter: async () => {
          throw new Error("adapter creation denied");
        },
        getPreferredCanvasFormat: () => "rgba8unorm",
      },
      schedule: (cb) => cb(),
      observe: false,
    });
    layer.register(button, BUTTON_OPTIONS);
    layer.render();

    expect(layer.debugState().backend).toBe("cpu");
    expect(layer.debugState().gpuFallbackReason).toContain("adapter creation denied");
    expect(stub.recording.putImageDataCalls).toBe(1);
    layer.dispose();
  });

  it("a mid-frame GPU failure switches ONCE to CPU and re-renders the same frame", async () => {
    const stub = stubGetContext();
    const device = new MockFullDevice();
    const layer = await UkiboriDom.create({
      backend: "auto",
      gpu: makeSeam(device),
      schedule: (cb) => cb(),
      observe: false,
    });
    layer.register(button, BUTTON_OPTIONS);
    layer.render();
    expect(layer.debugState().backend).toBe("webgpu");
    const gpuSubmitsBefore = device.submits.length;

    // Inject a failure into the NEXT frame's first encoder (the height pass):
    // the dom-layer must catch it, dispose the GPU pipeline, switch once to
    // the retained CPU canvas and re-render the frame there. setShadow forces
    // a scene-dirty render (an unchanged-geometry invalidate would be
    // skipped by the retained skip).
    device.failNextEncoder = true;
    layer.setShadow({ bias: 0.3 });
    layer.render();

    expect(layer.debugState().backend).toBe("cpu");
    expect(layer.debugState().gpuFallbackReason).toContain("injected encoder failure");
    expect(layer.debugState().gpuFrame).toBeNull();
    // The same frame was re-rendered on the CPU path (a real 2D paint).
    expect(stub.recording.putImageDataCalls).toBe(1);
    expect(layer.debugBuffers()).not.toBeNull();

    // Switch-once: subsequent renders never touch the (disposed) GPU.
    layer.setShadow({ bias: 0.2 });
    layer.render();
    expect(device.submits.length).toBe(gpuSubmitsBefore);
    expect(stub.recording.putImageDataCalls).toBe(2);
    layer.dispose();
  });

  it("device loss switches once to CPU and re-renders through the CPU canvas", async () => {
    const stub = stubGetContext();
    const device = new MockFullDevice();
    let scheduled = 0;
    const layer = await UkiboriDom.create({
      backend: "auto",
      gpu: makeSeam(device),
      schedule: (cb) => {
        scheduled++;
        cb();
      },
      observe: false,
    });
    layer.register(button, BUTTON_OPTIONS);
    layer.render();
    expect(layer.debugState().backend).toBe("webgpu");
    const paintedBefore = stub.recording.putImageDataCalls;

    device.triggerLoss();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(layer.debugState().backend).toBe("cpu");
    expect(layer.debugState().gpuFallbackReason).toBe("WebGPU device lost");
    // The loss handler scheduled a re-render that painted the CPU canvas.
    expect(scheduled).toBeGreaterThan(0);
    expect(stub.recording.putImageDataCalls).toBeGreaterThan(paintedBefore);
    layer.dispose();
  });

  it("dual-canvas ownership: contexts never mix and dispose removes both canvases", async () => {
    const stub = stubGetContext();
    const device = new MockFullDevice();
    const layer = await UkiboriDom.create({
      backend: "auto",
      gpu: makeSeam(device),
      schedule: (cb) => cb(),
      observe: false,
    });
    layer.register(button, BUTTON_OPTIONS);
    layer.render();

    const canvases = [...document.querySelectorAll("canvas[data-ukibori-overlay]")];
    expect(canvases).toHaveLength(2);
    const gpuRequests = stub.contextRequests.filter((r) => r.type === "webgpu");
    expect(gpuRequests.length).toBeGreaterThan(0);
    // The GPU canvas was only ever asked for "webgpu"; the CPU canvas has
    // never been touched on the GPU path (no 2D copy exists).
    expect(new Set(gpuRequests.map((r) => r.canvas)).size).toBe(1);
    expect(stub.contextRequests.filter((r) => r.type === "2d")).toHaveLength(0);

    // Fall back: the CPU canvas is now painted via "2d" — one distinct
    // canvas per context type, never the same node.
    device.failNextEncoder = true;
    layer.setShadow({ bias: 0.3 });
    layer.render();
    const webgpuRequestsAfterFallback = stub.contextRequests.filter((r) => r.type === "webgpu").length;
    expect(document.querySelectorAll("canvas[data-ukibori-overlay]")).toHaveLength(2);
    const cpuRequests = stub.contextRequests.filter((r) => r.type === "2d");
    expect(new Set(cpuRequests.map((r) => r.canvas)).size).toBe(1);
    expect(cpuRequests[0].canvas).not.toBe(gpuRequests[0].canvas);
    layer.setShadow({ bias: 0.2 });
    layer.render();
    // No NEW WebGPU acquisition after the fallback; every 2d request stays on
    // the one retained CPU canvas (getContext is re-issued per paint).
    expect(stub.contextRequests.filter((r) => r.type === "webgpu")).toHaveLength(webgpuRequestsAfterFallback);
    expect(new Set(stub.contextRequests.filter((r) => r.type === "2d").map((r) => r.canvas)).size).toBe(1);
    expect(layer.debugState().backend).toBe("cpu");

    // Dispose removes BOTH canvases and destroys every owned GPU allocation.
    layer.dispose();
    expect(document.querySelectorAll("canvas[data-ukibori-overlay]")).toHaveLength(0);
    expect(device.created.every((b) => b.destroyed)).toBe(true);
    expect(device.destroyed).toBe(true);
    expect(document.body.hasAttribute("data-ukibori-stage")).toBe(false);
  });

  it("the synchronous constructor rejects webgpu and the async webgpu path throws when unavailable", async () => {
    expect(() => new UkiboriDom({ backend: "webgpu" })).toThrow(/create\(\)/);

    await expect(
      UkiboriDom.create({
        backend: "webgpu",
        gpu: { requestAdapter: async () => null, getPreferredCanvasFormat: () => "rgba8unorm" },
        schedule: (cb) => cb(),
        observe: false,
      }),
    ).rejects.toThrow(/WebGPU requested but unavailable/);
    // The failed layer was disposed: no overlay canvas survives.
    expect(document.querySelectorAll("canvas[data-ukibori-overlay]")).toHaveLength(0);
  });
});

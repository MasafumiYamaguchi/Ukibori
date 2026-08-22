import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GpuCanvasConfigurationLike,
  GpuCanvasContextLike,
  GpuPipelineDeviceLike,
  GpuTextureLike,
} from "ukibori-renderer";
import { UkiboriDom } from "./dom-layer";
import type { DomGpuSource } from "./dom-layer";
import { OverlayCanvas } from "./overlay";

// ---------------------------------------------------------------------------
// Regression harness for the WebGPU blank-frame bug (Windows Chrome): the GPU
// path used to re-assign the canvas width/height attributes AFTER the
// presentation submit, which resets a canvas per the HTML spec ("set ...
// whether or not the value changes") and discards the presented frame — and
// retained scheduling then never re-presented it. It also double-applied dpr
// (buildScene already scales by dpr; encodeScene scaled again), producing
// DPR² extents that had to be shrunk post-present.
//
// The mocks below record a shared TIMELINE of backing-store setter calls and
// queue submissions so tests can assert ORDERING, not just final values.
// ---------------------------------------------------------------------------

class MockTexture implements GpuTextureLike {
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}
  createView(): { label: string } {
    return { label: "ukibori-mock-view" };
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

/**
 * Minimal device mock (the MockFullDevice surface trimmed to what these
 * tests observe): every queue.submit is recorded into a SHARED timeline so
 * resize-vs-submit ordering is observable across the whole lifecycle.
 */
function makeMockDevice(timeline: string[]) {
  const submits: unknown[][] = [];
  let errorListener: ((event: { message?: unknown }) => void) | null = null;
  let releaseLost: ((value: unknown) => void) | null = null;
  const lost = new Promise<unknown>((resolve) => {
    releaseLost = resolve;
  });

  const passEncoder = () => ({
    setPipeline(): void {},
    setBindGroup(): void {},
    dispatchWorkgroups(): void {},
    draw(): void {},
    end(): void {},
  });

  const device = {
    limits: {
      maxStorageBufferBindingSize: 1 << 28,
      maxBufferSize: 1 << 28,
      maxUniformBufferBindingSize: 16 * 1024,
      maxComputeWorkgroupSizeX: 256,
      maxComputeInvocationsPerWorkgroup: 256,
      maxComputeWorkgroupsPerDimension: 65535,
      maxStorageBuffersPerShaderStage: 8,
    },
    lost,
    destroy(): void {},
    addEventListener(
      type: string,
      fn: (event: { message?: unknown }) => void,
    ): void {
      if (type === "uncapturederror") {
        errorListener = fn;
      }
    },
    queue: {
      writeBuffer(_buffer: unknown, _offset: number, _source: Uint8Array): void {},
      submit(commandBuffers: readonly unknown[]): void {
        timeline.push("submit");
        submits.push([...commandBuffers]);
      },
    },
    createBuffer(desc: { size: number }): { size: number; destroy(): void } {
      return { size: desc.size, destroy(): void {} };
    },
    createShaderModule(desc: { code?: string; label?: string }): { label?: string } {
      return { label: desc.label };
    },
    createComputePipeline(desc: { label?: string }): { label?: string } {
      return { label: desc.label };
    },
    createRenderPipeline(desc: { label?: string }): { label?: string } {
      return { label: desc.label };
    },
    createBindGroupLayout(desc: { label?: string }): { label?: string } {
      return { label: desc.label };
    },
    createPipelineLayout(desc: { label?: string }): { label?: string } {
      return { label: desc.label };
    },
    createBindGroup(desc: { label?: string }): { label?: string } {
      return { label: desc.label };
    },
    createCommandEncoder(_desc?: { label?: string }): {
      beginComputePass(): ReturnType<typeof passEncoder>;
      beginRenderPass(): ReturnType<typeof passEncoder>;
      finish(): { label?: string };
    } {
      return {
        beginComputePass: passEncoder,
        beginRenderPass: passEncoder,
        finish: () => ({ label: "mock" }),
      };
    },
  };
  return {
    device,
    submits,
    emitError: (message: string) => errorListener?.({ message }),
    triggerLoss: () => releaseLost?.(undefined),
  };
}

interface Recording2dContext {
  putImageDataCalls: number;
}

/** Stub getContext: "webgpu" -> MockGpuContext per canvas; "2d" -> recorder. */
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
  const recording = { putImageDataCalls: 0 };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    (function (
      this: HTMLCanvasElement,
      ...args: unknown[]
    ): unknown {
      const type = String(args[0]);
      const canvas = this;
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
          clearRect: () => {},
        };
      }
      return null;
    }) as unknown as typeof HTMLCanvasElement.prototype.getContext,
  );
  return { contexts, recording };
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

function makeSeam(device: ReturnType<typeof makeMockDevice>["device"]): DomGpuSource {
  return {
    async requestAdapter() {
      return {
        async requestDevice() {
          return device as unknown as GpuPipelineDeviceLike & { destroy?: () => void };
        },
      };
    },
    getPreferredCanvasFormat() {
      return "rgba8unorm";
    },
  };
}

/** Overlay accessor for grabbing the lazily created WebGPU canvas. */
function gpuCanvasOf(layer: UkiboriDom): HTMLCanvasElement {
  const overlay = (layer as unknown as { overlay: OverlayCanvas }).overlay;
  return overlay.gpuCanvas();
}

/**
 * Replace instance width/height accessors with RECORDING ones that DELEGATE
 * to the real prototype accessors, logging every assignment into the shared
 * timeline (reads stay consistent with the actual attribute). This models the
 * real browser semantics under test: ANY attribute assignment — even a
 * same-value one — resets the canvas bitmap/context.
 */
function instrumentBackingStore(canvas: HTMLCanvasElement, timeline: string[]): void {
  const proto = Object.getPrototypeOf(canvas) as HTMLCanvasElement;
  const widthDesc = Object.getOwnPropertyDescriptor(proto, "width");
  const heightDesc = Object.getOwnPropertyDescriptor(proto, "height");
  if (!widthDesc?.get || !widthDesc.set || !heightDesc?.get || !heightDesc.set) {
    throw new Error("cannot instrument canvas size accessors");
  }
  Object.defineProperty(canvas, "width", {
    configurable: true,
    get: () => widthDesc.get!.call(canvas),
    set: (value: number) => {
      timeline.push(`resize-width ${widthDesc.get!.call(canvas)}->${value}`);
      widthDesc.set!.call(canvas, value);
    },
  });
  Object.defineProperty(canvas, "height", {
    configurable: true,
    get: () => heightDesc.get!.call(canvas),
    set: (value: number) => {
      timeline.push(`resize-height ${heightDesc.get!.call(canvas)}->${value}`);
      heightDesc.set!.call(canvas, value);
    },
  });
}

/**
 * The blank-frame invariant: a presented frame must survive. Every
 * backing-store write must happen while at least one LATER submission exists
 * in the timeline (the presentation that draws into the freshly sized
 * store); equivalently, the LAST event must always be a submission — nothing
 * may mutate the canvas after the final present.
 */
function assertNoPostPresentResize(timeline: readonly string[]): void {
  expect(timeline.length).toBeGreaterThan(0);
  expect(timeline[timeline.length - 1]).toBe("submit");
  timeline.forEach((event, index) => {
    if (event.startsWith("resize-")) {
      expect(
        timeline.slice(index + 1).some((e) => e === "submit"),
        `backing-store write "${event}" has no later presentation submit`,
      ).toBe(true);
    }
  });
}

describe("UkiboriDom — WebGPU canvas lifecycle / DPR contract (blank-frame regressions)", () => {
  // -- DPR contract: exactly ONE dpr application ---------------------------

  it.each([1, 1.5, 2] as const)(
    "renders at floor(region * dpr) texels at dpr %s — never DPR²",
    async (dpr) => {
      const stub = stubGetContext();
      const harness = makeMockDevice([]);
      const layer = await UkiboriDom.create({
        backend: "auto",
        gpu: makeSeam(harness.device),
        schedule: (cb) => cb(),
        observe: false,
        dpr,
        overlay: { stage: host },
      });
      layer.register(button, BUTTON_OPTIONS);
      layer.render();

      // Region: button 160x44 inflated by the default 64 margin -> 288x172.
      const expectedW = Math.floor(288 * dpr);
      const expectedH = Math.floor(172 * dpr);

      const state = layer.debugState();
      expect(state.backend).toBe("webgpu");
      expect(state.gpuFallbackReason).toBeNull();
      expect(state.dpr).toBe(dpr);

      // Encoder extent == device-pixel scene size (dpr applied ONCE).
      expect(state.gpuFrame!.frame.renderWidth).toBe(expectedW);
      expect(state.gpuFrame!.frame.renderHeight).toBe(expectedH);
      expect(state.renderSize).toEqual({ width: expectedW, height: expectedH });

      // The presented backing store matches the render extent EXACTLY.
      const gpuCanvas = gpuCanvasOf(layer);
      expect(gpuCanvas.width).toBe(expectedW);
      expect(gpuCanvas.height).toBe(expectedH);
      // The webgpu context was configured on exactly this canvas.
      expect([...stub.contexts.keys()]).toEqual([gpuCanvas]);
      expect([...stub.contexts.values()][0].configured).toHaveLength(1);

      // Explicit DPR² rejection (only meaningful when dpr != 1).
      if (dpr !== 1) {
        const squaredW = Math.floor(288 * dpr * dpr);
        const squaredH = Math.floor(172 * dpr * dpr);
        expect(state.gpuFrame!.frame.renderWidth).not.toBe(squaredW);
        expect(state.gpuFrame!.frame.renderHeight).not.toBe(squaredH);
        expect(gpuCanvas.width).not.toBe(squaredW);
        expect(gpuCanvas.height).not.toBe(squaredH);
      }

      // CSS placement still happened (pure style writes, no bitmap reset).
      expect(gpuCanvas.style.width).toBe("288px");
      expect(gpuCanvas.style.height).toBe("172px");

      // No readback / 2D copy on the GPU path.
      expect(layer.debugBuffers()).toBeNull();
      layer.dispose();
    },
  );

  // -- Canvas lifecycle: no width/height write after the present ------------

  it("never writes the GPU canvas width/height after the presentation submit", async () => {
    stubGetContext();
    const timeline: string[] = [];
    const harness = makeMockDevice(timeline);
    const layer = await UkiboriDom.create({
      backend: "auto",
      gpu: makeSeam(harness.device),
      schedule: (cb) => cb(),
      observe: false,
      overlay: { stage: host },
    });

    // Instrument BEFORE the first render so every write is captured.
    const gpuCanvas = gpuCanvasOf(layer);
    instrumentBackingStore(gpuCanvas, timeline);

    layer.register(button, BUTTON_OPTIONS);
    layer.render();

    // Full chain: 4 compute submits + 1 presentation submit; the guarded
    // backing-store writes sit between them (300x150 default -> 288x172).
    expect(timeline).toEqual([
      "submit",
      "submit",
      "submit",
      "submit",
      "resize-width 300->288",
      "resize-height 150->172",
      "submit",
    ]);
    assertNoPostPresentResize(timeline);

    // A second identical render must not touch the canvas AT ALL (no new
    // events of any kind).
    const frozen = [...timeline];
    layer.render();
    expect(timeline).toEqual(frozen);

    // CSS placement was still applied after the present (styles only).
    expect(gpuCanvas.style.left).toBe("36px");
    expect(gpuCanvas.style.top).toBe("136px");
    expect(gpuCanvas.style.width).toBe("288px");
    layer.dispose();
  });

  // -- Retained scheduling preserves the presented frame --------------------

  it("retained unchanged frame: no re-present AND no backing-store mutation", async () => {
    stubGetContext();
    const timeline: string[] = [];
    const harness = makeMockDevice(timeline);
    const onError = vi.fn();
    const layer = await UkiboriDom.create({
      backend: "auto",
      gpu: makeSeam(harness.device),
      schedule: (cb) => cb(),
      observe: false,
      onError,
      overlay: { stage: host },
    });
    instrumentBackingStore(gpuCanvasOf(layer), timeline);

    layer.register(button, BUTTON_OPTIONS);
    layer.render();

    const gpuCanvas = gpuCanvasOf(layer);
    const dimsAfterPresent = { w: gpuCanvas.width, h: gpuCanvas.height };
    const submitsAfterPresent = harness.submits.length;

    // Force the pipeline through a rebuild whose bytes are IDENTICAL:
    // setShadow({}) marks the scene dirty without changing any effective
    // option (shadow state was already the empty set). The scheduler runs
    // synchronously, so the retained pass executes inside setShadow.
    layer.setShadow({});
    // An explicit second render hits the dom-level unchanged skip.
    layer.render();

    expect(harness.submits.length).toBe(submitsAfterPresent);
    expect(timeline.filter((e) => e.startsWith("resize-"))).toHaveLength(2);
    assertNoPostPresentResize(timeline);
    expect(gpuCanvas.width).toBe(dimsAfterPresent.w);
    expect(gpuCanvas.height).toBe(dimsAfterPresent.h);

    // The last executed pipeline frame was FULLY retained (no reasons, no
    // stages executed) yet its stats were committed honestly.
    const frame = layer.debugState().gpuFrame!.frame;
    expect(frame.invalidation.reasons).toEqual([]);
    expect(frame.invalidation.retained).toBe(true);
    expect(onError).not.toHaveBeenCalled();
    layer.dispose();
  });

  // -- DPR changes: one guarded resize BEFORE the next present --------------

  it("applies a DPR change as a single pre-present resize followed by a fresh present (1 -> 2 -> 1.5)", async () => {
    stubGetContext();
    const timeline: string[] = [];
    const harness = makeMockDevice(timeline);
    const layer = await UkiboriDom.create({
      backend: "auto",
      gpu: makeSeam(harness.device),
      schedule: (cb) => cb(),
      observe: false,
      overlay: { stage: host },
    });
    instrumentBackingStore(gpuCanvasOf(layer), timeline);

    layer.register(button, BUTTON_OPTIONS);
    layer.render(); // dpr 1: 288x172
    const eventsAfterInitial = timeline.length;

    layer.setDpr(2);
    layer.render();
    // Exactly one guarded pair between initial frame and the new present.
    // The pipeline sizes the store right BEFORE its own presentation (after
    // the four compute submissions of the full chain).
    expect(timeline.slice(eventsAfterInitial)).toEqual([
      "submit",
      "submit",
      "submit",
      "submit",
      "resize-width 288->576",
      "resize-height 172->344",
      "submit",
    ]);
    expect(gpuCanvasOf(layer).width).toBe(Math.floor(288 * 2));
    expect(gpuCanvasOf(layer).height).toBe(Math.floor(172 * 2));
    expect(layer.debugState().gpuFrame!.frame.renderWidth).toBe(576);
    assertNoPostPresentResize(timeline);

    const eventsAfterDpr2 = timeline.length;
    layer.setDpr(1.5);
    layer.render();
    expect(timeline.slice(eventsAfterDpr2)).toEqual([
      "submit",
      "submit",
      "submit",
      "submit",
      "resize-width 576->432",
      "resize-height 344->258",
      "submit",
    ]);
    expect(gpuCanvasOf(layer).width).toBe(Math.floor(288 * 1.5));
    expect(gpuCanvasOf(layer).height).toBe(Math.floor(172 * 1.5));
    expect(layer.debugState().dpr).toBe(1.5);
    assertNoPostPresentResize(timeline);

    layer.dispose();
  });

  // -- Diagnostics seam ------------------------------------------------------

  it("records device uncapturederror messages via debugGpuDiagnostics()", async () => {
    stubGetContext();
    const timeline: string[] = [];
    const harness = makeMockDevice(timeline);
    const onError = vi.fn();
    const layer = await UkiboriDom.create({
      backend: "auto",
      gpu: makeSeam(harness.device),
      schedule: (cb) => cb(),
      observe: false,
      onError,
      overlay: { stage: host },
    });

    harness.emitError("Validation error: attachment format mismatch");
    const diagnostics = layer.debugGpuDiagnostics();
    expect(diagnostics).toEqual(["Validation error: attachment format mismatch"]);
    expect(layer.debugState().gpuDiagnostics).toEqual([
      "Validation error: attachment format mismatch",
    ]);
    // Surfaced through the standard error reporter too.
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0][0])).toContain("uncapturederror");
    layer.dispose();
  });
});

// ---------------------------------------------------------------------------
// OverlayCanvas unit contract: same-value backing-store writes are forbidden.
// ---------------------------------------------------------------------------

describe("OverlayCanvas — guarded backing-store writes", () => {
  it("skips same-value width/height assignments and keeps positionCanvases CSS-only", () => {
    const overlay = new OverlayCanvas(host);
    let widthSets = 0;
    let heightSets = 0;
    const proto = Object.getPrototypeOf(overlay.canvas) as HTMLCanvasElement;
    const widthDesc = Object.getOwnPropertyDescriptor(proto, "width")!;
    const heightDesc = Object.getOwnPropertyDescriptor(proto, "height")!;
    Object.defineProperty(overlay.canvas, "width", {
      configurable: true,
      get: () => widthDesc.get!.call(overlay.canvas),
      set: (v: number) => {
        widthSets++;
        widthDesc.set!.call(overlay.canvas, v);
      },
    });
    Object.defineProperty(overlay.canvas, "height", {
      configurable: true,
      get: () => heightDesc.get!.call(overlay.canvas),
      set: (v: number) => {
        heightSets++;
        heightDesc.set!.call(overlay.canvas, v);
      },
    });

    overlay.resizeBackingStore(320, 240);
    expect(widthSets).toBe(1);
    expect(heightSets).toBe(1);
    // The REAL attribute was written (delegated accessor).
    expect(widthDesc.get!.call(overlay.canvas)).toBe(320);
    expect(heightDesc.get!.call(overlay.canvas)).toBe(240);

    // Same-value calls are NO-OPS (a redundant assignment would reset the
    // canvas bitmap/context per the HTML spec even though the value matches).
    overlay.resizeBackingStore(320, 240);
    expect(widthSets).toBe(1);
    expect(heightSets).toBe(1);

    // Pure CSS placement never touches the attributes.
    overlay.positionCanvases({ x: 11, y: 22, w: 33, h: 44 });
    expect(widthSets).toBe(1);
    expect(heightSets).toBe(1);
    expect(overlay.canvas.style.left).toBe("11px");
    expect(overlay.canvas.style.top).toBe("22px");
    expect(overlay.canvas.style.width).toBe("33px");
    expect(overlay.canvas.style.height).toBe("44px");
  });

  it("keeps the WebGPU canvas out of resizeBackingStore (pipeline-owned)", () => {
    const overlay = new OverlayCanvas(host);
    const gpuCanvas = overlay.gpuCanvas();
    let gpuWidthSets = 0;
    const proto = Object.getPrototypeOf(gpuCanvas) as HTMLCanvasElement;
    const widthDesc = Object.getOwnPropertyDescriptor(proto, "width")!;
    Object.defineProperty(gpuCanvas, "width", {
      configurable: true,
      get: () => widthDesc.get!.call(gpuCanvas),
      set: (v: number) => {
        gpuWidthSets++;
        widthDesc.set!.call(gpuCanvas, v);
      },
    });

    overlay.resizeBackingStore(200, 100);
    overlay.positionCanvases({ x: 0, y: 0, w: 100, h: 50 });
    // Only the CPU canvas's backing store is overlay-managed.
    expect(gpuWidthSets).toBe(0);
  });
});

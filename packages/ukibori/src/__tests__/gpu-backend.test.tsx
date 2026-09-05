import { StrictMode } from "react";
import { act } from "react";
import { render, screen } from "@testing-library/react";
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
import type { DomGpuSource } from "ukibori-dom";
import { Surface, Ukibori } from "../index";
import type { UkiboriDom } from "ukibori-dom";
import { stubCanvas2d, stubElementRects } from "../test/dom";

/**
 * Backend policy with real WebGPU: "auto" requests a real navigator.gpu
 * adapter/device and uses the #29/#31 GpuScenePipeline DIRECT canvas
 * presentation (no readback, no 2D copy); any GPU failure switches once to
 * the honest CPU reference path. "cpu" stays CPU. "webgpu" is WebGPU-only —
 * an unavailable GPU is reported and the explicitly labeled CSS approximation
 * is used so surfaces are never suppressed-but-unpainted.
 */

const flushAsync = () =>
  act(async () => {
    // The layer effect is now ASYNC (UkiboriDom.create awaits adapter/
    // device acquisition), so several turns are needed: capability state
    // commit -> layer effect re-run -> create() microtask chain -> setLayer
    // commit -> surface registration.
    for (let i = 0; i < 4; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });

// jsdom has no ImageData global; the CPU overlay paint and mask
// rasterization need it (the shared stubCanvas2d helper installs the same).
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

// ---------------------------------------------------------------------------
// Full structural WebGPU mock (the GpuScenePipeline harness pattern)
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
    this.log.push("beginRenderPass");
    return new MockRenderPass();
  }
  finish(): { label?: string } {
    return { label: "mock" };
  }
}

class MockGpuContext implements GpuCanvasContextLike {
  readonly canvas: HTMLCanvasElement;
  readonly configured: GpuCanvasConfigurationLike[] = [];
  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }
  configure(desc: GpuCanvasConfigurationLike): void {
    this.configured.push(desc);
  }
  unconfigure(): void {}
  getCurrentTexture(): GpuTextureLike {
    return new MockTexture(this.canvas.width, this.canvas.height);
  }
}

class MockFullDevice {
  readonly limits: GpuLimitsLike & GpuPresentationLimitsLike;
  readonly submits: unknown[][] = [];
  /** never resolves in these tests (a resolved promise would simulate loss) */
  readonly lost: Promise<never> = new Promise(() => {});
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
  }
  readonly queue = {
    writeBuffer: (): void => {},
    submit: (commandBuffers: readonly unknown[]): void => {
      this.submits.push([...commandBuffers]);
    },
  };
  createBuffer(desc: { size: number; usage: number; label?: string }): GpuBufferLike {
    return new MockBuffer(desc.size, desc.usage, desc.label);
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
  createBindGroupLayout(desc: { label?: string }): GpuBindGroupLayoutLike {
    return { label: desc.label };
  }
  createPipelineLayout(desc: { label?: string; bindGroupLayouts: readonly GpuBindGroupLayoutLike[] }): GpuPipelineLayoutLike {
    return { label: desc.label };
  }
  createBindGroup(desc: { label?: string; entries: readonly GpuBindGroupEntryLike[] }): GpuBindGroupLike {
    return { label: desc.label };
  }
  createCommandEncoder(): MockFullEncoder {
    return new MockFullEncoder();
  }
}

function makeGpuSource(device: MockFullDevice): DomGpuSource {
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

/** Stub navigator.gpu (saved/restored per test) and canvas contexts:
 * "webgpu" -> per-call MockGpuContext; "2d" -> a minimal working context
 * (overlay CPU paint + capability probe + mask rasterization). */
function stubWebGpu(device: MockFullDevice) {
  const gpuSource = makeGpuSource(device);
  const hadGpu = Object.prototype.hasOwnProperty.call(navigator, "gpu");
  const previous = (navigator as { gpu?: unknown }).gpu;
  Object.defineProperty(navigator, "gpu", {
    value: gpuSource,
    configurable: true,
    writable: true,
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    (function (
      this: HTMLCanvasElement,
      ...args: unknown[]
    ): unknown {
      if (String(args[0]) === "webgpu") {
        return new MockGpuContext(this);
      }
      return stubCanvas2dContext(this);
    }) as unknown as typeof HTMLCanvasElement.prototype.getContext,
  );
  return () => {
    if (hadGpu) {
      Object.defineProperty(navigator, "gpu", {
        value: previous,
        configurable: true,
        writable: true,
      });
    } else {
      delete (navigator as { gpu?: unknown }).gpu;
    }
  };
}

/** Minimal 2d context for the overlay CPU canvas + mask rasterization. */
function stubCanvas2dContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const width = canvas.width;
  const height = canvas.height;
  return {
    putImageData: () => undefined,
    clearRect: () => undefined,
    getImageData: () => {
      const data = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < width * height; i++) {
        const x = i % width;
        const y = Math.floor(i / width);
        const inGlyph = x >= width / 4 && x < (3 * width) / 4 && y >= height / 4 && y < (3 * height) / 4;
        data[i * 4 + 3] = inGlyph ? 255 : 0;
      }
      return { width, height, data };
    },
    fillText: () => undefined,
  } as unknown as CanvasRenderingContext2D;
}

beforeEach(() => {
  stubElementRects();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("React backend — WebGPU selection", () => {
  it('"auto" with a real navigator.gpu uses WebGPU and presents directly', async () => {
    const device = new MockFullDevice();
    const restore = stubWebGpu(device);
    let layer: UkiboriDom | null = null;
    const { unmount } = render(
      <Ukibori
        backend="auto"
        schedule={(cb) => cb()}
        onReady={(l) => (layer = l)}
        environment={{ intensity: 0.62, specularIntensity: 0.72 }}
        exposure={1.04}
        shadow={{ bias: 0.22, maxDistance: 100 }}
      >
        <Surface sceneId="a" elevation={4} thickness={2}>
          A
        </Surface>
      </Ukibori>,
    );
    await flushAsync();

    expect(layer).not.toBeNull();
    const state = layer!.debugState();
    expect(state.backend).toBe("webgpu");
    expect(state.gpuFallbackReason).toBeNull();
    expect(state.gpuFrame).not.toBeNull();
    // Direct GPU presentation: the whole #31/#53 chain submitted (the hard
    // frame runs the #53 ring-rule refinement stage), no 2D copy.
    expect(device.submits.length).toBe(6);
    expect(layer!.debugBuffers()).toBeNull();

    // Scene/environment/exposure/shadow options keep flowing on the GPU path:
    // an environment change now re-runs ONLY lighting+presentation (the
    // height/normal fields stay retained).
    layer!.setEnvironment({ intensity: 0.2 });
    layer!.render();
    expect(device.submits.length).toBe(8);
    expect(layer!.debugState().gpuFrame!.frame.invalidation.reasons).toEqual([
      "environment",
    ]);
    expect(layer!.debugState().gpuFrame!.frame.invalidation.executed).toEqual([
      "upload",
      "lighting",
      "presentation",
    ]);

    unmount();
    restore();
    expect(document.querySelectorAll("canvas[data-ukibori-overlay]")).toHaveLength(0);
  });

  it('"auto" without navigator.gpu falls back to the honest CPU path', async () => {
    stubCanvas2d();
    let layer: UkiboriDom | null = null;
    const errors: unknown[] = [];
    render(
      <Ukibori
        backend="auto"
        schedule={(cb) => cb()}
        onReady={(l) => (layer = l)}
        onError={(e) => errors.push(e)}
      >
        <Surface sceneId="a" elevation={4} thickness={2}>
          A
        </Surface>
      </Ukibori>,
    );
    await flushAsync();

    expect(layer).not.toBeNull();
    const state = layer!.debugState();
    expect(state.backend).toBe("cpu");
    expect(state.gpuFallbackReason).toContain("adapter");
    expect(state.gpuFrame).toBeNull();
    // The CPU reference path stays fully functional (host debug buffers).
    expect(layer!.debugBuffers()).not.toBeNull();
    // A silent auto fallback is not an error report.
    expect(errors).toHaveLength(0);
  });

  it('"cpu" stays CPU and never touches navigator.gpu', async () => {
    stubCanvas2d();
    const adapterSpy = vi.fn(async () => null);
    const hadGpu = Object.prototype.hasOwnProperty.call(navigator, "gpu");
    const previous = (navigator as { gpu?: unknown }).gpu;
    Object.defineProperty(navigator, "gpu", {
      value: { requestAdapter: adapterSpy, getPreferredCanvasFormat: () => "rgba8unorm" },
      configurable: true,
      writable: true,
    });
    let layer: UkiboriDom | null = null;
    render(
      <Ukibori backend="cpu" schedule={(cb) => cb()} onReady={(l) => (layer = l)}>
        <Surface sceneId="a" elevation={4} thickness={2}>
          A
        </Surface>
      </Ukibori>,
    );
    await flushAsync();
    expect(adapterSpy).not.toHaveBeenCalled();
    expect(layer!.debugState().backend).toBe("cpu");
    if (hadGpu) {
      Object.defineProperty(navigator, "gpu", {
        value: previous,
        configurable: true,
        writable: true,
      });
    } else {
      delete (navigator as { gpu?: unknown }).gpu;
    }
  });

  it('explicit "webgpu" without GPU reports the error and uses the labeled CSS approximation', async () => {
    stubCanvas2d();
    let layer: UkiboriDom | null = null;
    const errors: unknown[] = [];
    render(
      <Ukibori
        backend="webgpu"
        schedule={(cb) => cb()}
        onReady={(l) => (layer = l)}
        onError={(e) => errors.push(e)}
      >
        <Surface sceneId="a" elevation={4} variant="raised">
          A
        </Surface>
      </Ukibori>,
    );
    await flushAsync();

    expect(layer).toBeNull();
    expect(errors.length).toBeGreaterThan(0);
    expect(String(errors[0])).toContain("WebGPU requested but unavailable");
    // The explicitly labeled approximation is applied — never suppressed.
    const el = screen.getByText("A");
    expect(el.style.boxShadow).toContain("var(--ukibori-shadow-x)");
    expect(document.querySelector("canvas")).toBeNull();
  });

  it("StrictMode double-invocation cancels the first async creation cleanly", async () => {
    const device = new MockFullDevice();
    const restore = stubWebGpu(device);
    let readyLayers: Array<UkiboriDom | null> = [];
    const { unmount } = render(
      <StrictMode>
        <Ukibori
          backend="auto"
          schedule={(cb) => cb()}
          onReady={(l) => readyLayers.push(l)}
        >
          <Surface sceneId="a" elevation={4} thickness={2}>
            A
          </Surface>
        </Ukibori>
      </StrictMode>,
    );
    await flushAsync();
    await flushAsync();

    // StrictMode runs the effect twice: the FIRST in-flight creation is
    // cancelled and disposed; exactly one layer is ever published.
    expect(readyLayers.filter((l) => l !== null)).toHaveLength(1);
    const layer = readyLayers.find((l) => l !== null)!;
    expect(layer.debugState().backend).toBe("webgpu");
    // The survivor owns exactly one CPU canvas + one GPU canvas; the
    // cancelled creation removed its canvases.
    expect(document.querySelectorAll("canvas[data-ukibori-overlay]")).toHaveLength(2);

    unmount();
    restore();
    expect(document.querySelectorAll("canvas[data-ukibori-overlay]")).toHaveLength(0);
  });
});

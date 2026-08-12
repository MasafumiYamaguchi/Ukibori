import { CpuBackend } from "./backend/cpu";
import { createWebGpuBackend } from "./backend/webgpu";
import { assertValidSpec, byteLength, elementSize } from "./buffer";
import { WasmCpuBackend } from "./wasm/backend";
import { WasmNormalKernel } from "./wasm/kernel";
import { selectWasmBackend } from "./wasm/selection";
import type { WasmSelectionOptions, WasmSelectionReport } from "./wasm/selection";
import type {
  BackendCapabilities,
  BufferSpec,
  RenderBackend,
  RenderBuffer,
} from "./types";

export type Quality = "low" | "medium" | "high";

export interface RendererOptions {
  quality?: Quality;
  /** render-target pixels per CSS pixel; not used until the render pipeline exists */
  devicePixelRatio?: number;
}

/**
 * Deterministic test data for a buffer. Proves the
 * backend write -> read -> visualize loop without pretending to be the real
 * render pipeline.
 *
 * - f32/u16/u32: x-axis ramp in channel 0, y-axis ramp in channel 1+
 * - u8 color (3+ channels): checkerboard
 * - other u8: grayscale x ramp
 */
export function testPatternBytes(spec: BufferSpec): Uint8Array {
  assertValidSpec(spec);
  const out = new Uint8Array(byteLength(spec));
  const view = new DataView(out.buffer);
  const el = elementSize(spec.format);
  const isColor = spec.format === "u8" && spec.channels >= 3;
  for (let y = 0; y < spec.height; y++) {
    for (let x = 0; x < spec.width; x++) {
      const px = (x + 0.5) / spec.width;
      const py = (y + 0.5) / spec.height;
      for (let c = 0; c < spec.channels; c++) {
        const offset = ((y * spec.width + x) * spec.channels + c) * el;
        if (isColor) {
          const v = (x + y) % 2 === 0 ? 255 : 72;
          view.setUint8(offset, v);
          continue;
        }
        const value = c === 0 ? px : py;
        switch (spec.format) {
          case "f32":
            view.setFloat32(offset, value, true);
            break;
          case "u16":
            view.setUint16(offset, Math.round(value * 65535), true);
            break;
          case "u32":
            view.setUint32(offset, Math.round(value * 0xffffffff), true);
            break;
          case "u8":
            view.setUint8(offset, Math.round(value * 255));
            break;
        }
      }
    }
  }
  return out;
}

/**
 * Renderer shell for the verification environment.
 *
 * Owns render targets and the backend. The actual SDF/height/normal/shadow
 * pipeline is deliberately not here; later geometry/lighting issues implement
 * passes that write into these targets through the backend.
 */
export class UkiboriRenderer {
  readonly backend: RenderBackend;
  readonly quality: Quality;
  readonly devicePixelRatio: number;
  private readonly targets = new Map<string, RenderBuffer>();

  constructor(backend: RenderBackend, options: RendererOptions = {}) {
    this.backend = backend;
    this.quality = options.quality ?? "medium";
    this.devicePixelRatio = options.devicePixelRatio ?? 1;
  }

  /** Create a target, or return the existing one when the spec matches. */
  async ensureTarget(name: string, spec: BufferSpec): Promise<RenderBuffer> {
    const existing = this.targets.get(name);
    if (existing !== undefined) {
      const s = existing.spec;
      if (s.width === spec.width && s.height === spec.height && s.channels === spec.channels && s.format === spec.format) {
        return existing;
      }
      existing.dispose();
    }
    const buffer = await this.backend.createBuffer(spec);
    this.targets.set(name, buffer);
    return buffer;
  }

  getTarget(name: string): RenderBuffer | undefined {
    return this.targets.get(name);
  }

  /** Fill every registered target with deterministic test data. */
  async renderTestPattern(): Promise<void> {
    for (const buffer of this.targets.values()) {
      await buffer.writeBytes(testPatternBytes(buffer.spec));
    }
  }

  dispose(): void {
    for (const buffer of this.targets.values()) {
      buffer.dispose();
    }
    this.targets.clear();
    this.backend.dispose();
  }
}

export interface CreateRendererOptions extends RendererOptions {
  /**
   * Backend policy:
   * - "auto" (default): WebGPU detection/initialization STARTS FIRST and is
   *   never delayed by WASM compilation or benchmarking. When WebGPU
   *   succeeds it is used and the optional WASM load is abandoned
   *   (disposed asynchronously, off the critical path). When WebGPU is
   *   unavailable, the WASM-assisted CPU path is selected if WebAssembly is
   *   supported and a bounded startup probe demonstrates a documented
   *   benefit; otherwise the plain CPU (TypeScript oracle) backend is used.
   * - "webgpu": WebGPU only (throws when unavailable).
   * - "wasm": WASM-assisted CPU path (falls back to plain CPU when
   *   unsupported or when probe parity fails; never throws).
   * - "cpu": the plain TypeScript oracle backend.
   */
  backend?: "auto" | "webgpu" | "wasm" | "cpu";
  /** WASM selection options (probe size, iterations, deterministic
   * overrides). Ignored when WebGPU is selected. */
  wasm?: WasmSelectionOptions;
}

export interface CreatedRenderer {
  renderer: UkiboriRenderer;
  backend: RenderBackend;
  capabilities: BackendCapabilities;
  /**
   * WASM selection evidence when the WASM path was evaluated (auto/wasm),
   * including the decision, probe timing/parity and the fallback reason.
   * `null` when WebGPU was selected first or `backend: "cpu"` was explicit.
   */
  wasmSelection: WasmSelectionReport | null;
}

/** The loaded kernel of a WASM selection (guaranteed when selected). */
function selectedKernel(selection: WasmSelectionReport): WasmNormalKernel {
  if (selection.selected !== "wasm" || selection.kernel === null) {
    throw new Error("internal: WASM selection without a loaded kernel");
  }
  return selection.kernel;
}

export async function createRenderer(
  options: CreateRendererOptions = {},
): Promise<CreatedRenderer> {
  let backend: RenderBackend;
  let wasmSelection: WasmSelectionReport | null = null;
  if (options.backend === "cpu") {
    backend = new CpuBackend();
  } else if (options.backend === "webgpu") {
    const gpu = await createWebGpuBackend();
    if (gpu === null) {
      throw new Error("WebGPU backend requested but unavailable");
    }
    backend = gpu;
  } else if (options.backend === "wasm") {
    const selection = await selectWasmBackend(options.wasm ?? {});
    wasmSelection = selection;
    backend = selection.selected === "wasm" ? new WasmCpuBackend(selectedKernel(selection), selection) : new CpuBackend();
  } else {
    // "auto": WebGPU detection starts FIRST; the WASM path is evaluated in
    // parallel but is never awaited for the WebGPU decision and is never on
    // WebGPU's critical path.
    const gpuPromise = createWebGpuBackend();
    const wasmPromise = selectWasmBackend(options.wasm ?? {});
    const gpu = await gpuPromise;
    if (gpu !== null) {
      // WebGPU wins: release the optional WASM kernel off the critical path.
      void wasmPromise.then((selection) => {
        if (selection.selected === "wasm") {
          selection.kernel?.dispose();
        }
      });
      backend = gpu;
    } else {
      const selection = await wasmPromise;
      wasmSelection = selection;
      backend =
        selection.selected === "wasm"
          ? new WasmCpuBackend(selectedKernel(selection), selection)
          : new CpuBackend();
    }
  }
  const renderer = new UkiboriRenderer(backend, options);
  return { renderer, backend, capabilities: backend.capabilities, wasmSelection };
}

import { readElement } from "../buffer";
import type { BufferData } from "../types";

export interface RgbaImage {
  width: number;
  height: number;
  /** RGBA, width * height * 4 bytes */
  data: Uint8ClampedArray;
}

export type DebugMode = "auto" | "height" | "normal" | "color";

export interface ToRgbaOptions {
  mode?: DebugMode;
  /** height visualization range; defaults to the buffer min/max */
  min?: number;
  max?: number;
}

function detectMode(data: BufferData): Exclude<DebugMode, "auto"> {
  if (data.spec.format === "u8" && data.spec.channels >= 3) {
    return "color";
  }
  if (data.spec.format === "f32" && data.spec.channels >= 3) {
    return "normal";
  }
  return "height";
}

/**
 * Convert an intermediate render buffer into an RGBA image so humans can
 * inspect height / normal / visibility buffers, not just the final look.
 */
export function toRgbaBytes(data: BufferData, options: ToRgbaOptions = {}): RgbaImage {
  const mode = options.mode === undefined || options.mode === "auto"
    ? detectMode(data)
    : options.mode;
  const { width, height } = data.spec;
  const out = new Uint8ClampedArray(width * height * 4);

  if (mode === "color") {
    toColor(data, out);
  } else if (mode === "normal") {
    toNormal(data, out);
  } else {
    toHeight(data, out, options.min, options.max);
  }
  return { width, height, data: out };
}

function toHeight(data: BufferData, out: Uint8ClampedArray, min?: number, max?: number): void {
  let lo = min ?? Infinity;
  let hi = max ?? -Infinity;
  if (min === undefined || max === undefined) {
    for (let y = 0; y < data.spec.height; y++) {
      for (let x = 0; x < data.spec.width; x++) {
        const v = readElement(data.bytes, data.spec, x, y, 0);
        if (!Number.isFinite(v)) {
          continue;
        }
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
  }
  const range = hi - lo;
  // A constant-height buffer should not render black: fall back to [0, max(hi, 1)].
  const lo0 = Number.isFinite(range) && range > 0 ? lo : 0;
  const hi0 = Number.isFinite(range) && range > 0 ? hi : Math.max(hi, 1);
  const range0 = hi0 - lo0;
  for (let y = 0; y < data.spec.height; y++) {
    for (let x = 0; x < data.spec.width; x++) {
      let v = readElement(data.bytes, data.spec, x, y, 0);
      v = Number.isFinite(v) ? v : 0;
      const t = range0 > 0 ? (v - lo0) / range0 : 0;
      const gray = Math.round(t * 255);
      const p = (y * data.spec.width + x) * 4;
      out[p] = gray;
      out[p + 1] = gray;
      out[p + 2] = gray;
      out[p + 3] = 255;
    }
  }
}

function toNormal(data: BufferData, out: Uint8ClampedArray): void {
  const { width, height } = data.spec;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const v = readElement(data.bytes, data.spec, x, y, c);
        const t = Number.isFinite(v) ? v : 0;
        out[p + c] = Math.round(clamp01((t + 1) / 2) * 255);
      }
      out[p + 3] = 255;
    }
  }
}

function toColor(data: BufferData, out: Uint8ClampedArray): void {
  const { width, height } = data.spec;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const v = readElement(data.bytes, data.spec, x, y, c);
        out[p + c] = Number.isFinite(v) ? v : 0;
      }
      const hasAlpha = data.spec.channels >= 4;
      const a = hasAlpha ? readElement(data.bytes, data.spec, x, y, 3) : 255;
      out[p + 3] = Number.isFinite(a) ? a : 255;
    }
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Encode an RGBA image as a binary P6 PPM (RGB). Zero dependencies, so
 * intermediate buffers can be dumped to files from tests or CLI tools.
 */
export function toPpmBytes(image: RgbaImage): Uint8Array {
  const header = `P6\n${image.width} ${image.height}\n255\n`;
  const body = new Uint8Array(image.width * image.height * 3);
  for (let i = 0; i < image.width * image.height; i++) {
    body[i * 3] = image.data[i * 4];
    body[i * 3 + 1] = image.data[i * 4 + 1];
    body[i * 3 + 2] = image.data[i * 4 + 2];
  }
  const head = new TextEncoder().encode(header);
  const out = new Uint8Array(head.byteLength + body.byteLength);
  out.set(head, 0);
  out.set(body, head.byteLength);
  return out;
}

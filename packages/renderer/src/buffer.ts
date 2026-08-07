import type { BufferData, BufferFormat, BufferSpec, RenderBuffer } from "./types";

export const ELEMENT_SIZES: Record<BufferFormat, number> = {
  f32: 4,
  u16: 2,
  u32: 4,
  u8: 1,
};

export function elementSize(format: BufferFormat): number {
  return ELEMENT_SIZES[format];
}

export function byteLength(spec: BufferSpec): number {
  return spec.width * spec.height * spec.channels * elementSize(spec.format);
}

const VALID_CHANNELS = new Set<number>([1, 2, 3, 4]);

export function assertValidSpec(spec: BufferSpec): void {
  if (
    !Number.isInteger(spec.width) ||
    spec.width <= 0 ||
    !Number.isInteger(spec.height) ||
    spec.height <= 0
  ) {
    throw new RangeError(`invalid buffer dimensions: ${spec.width}x${spec.height}`);
  }
  if (!VALID_CHANNELS.has(spec.channels)) {
    throw new RangeError(`invalid channel count: ${spec.channels}`);
  }
  if (!(spec.format in ELEMENT_SIZES)) {
    throw new RangeError(`invalid buffer format: ${spec.format}`);
  }
}

function typedArrayFor(format: BufferFormat) {
  switch (format) {
    case "f32":
      return Float32Array;
    case "u16":
      return Uint16Array;
    case "u32":
      return Uint32Array;
    case "u8":
      return Uint8Array;
  }
}

/**
 * CPU-resident buffer. Pixels are tightly packed in row-major order with no
 * padding: `data[(y * width + x) * channels + c]`.
 */
export class HostBuffer implements RenderBuffer {
  readonly spec: BufferSpec;
  readonly data: Float32Array | Uint16Array | Uint32Array | Uint8Array;

  constructor(spec: BufferSpec) {
    assertValidSpec(spec);
    this.spec = spec;
    const Ctor = typedArrayFor(spec.format);
    this.data = new Ctor(byteLength(spec) / elementSize(spec.format));
  }

  get(x: number, y: number, channel = 0): number {
    this.checkPixel(x, y, channel);
    return this.data[(y * this.spec.width + x) * this.spec.channels + channel];
  }

  set(x: number, y: number, channel: number, value: number): void {
    this.checkPixel(x, y, channel);
    this.data[(y * this.spec.width + x) * this.spec.channels + channel] = value;
  }

  fill(value: number): void {
    this.data.fill(value);
  }

  async writeBytes(bytes: Uint8Array, byteOffset = 0): Promise<void> {
    if (byteOffset + bytes.byteLength > this.data.byteLength) {
      throw new RangeError("write exceeds buffer size");
    }
    new Uint8Array(this.data.buffer).set(bytes, byteOffset);
  }

  async readBytes(): Promise<Uint8Array> {
    return new Uint8Array(this.data.buffer).slice();
  }

  dispose(): void {
    // CPU buffers hold no external resources.
  }

  private checkPixel(x: number, y: number, channel: number): void {
    if (
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      x < 0 ||
      y < 0 ||
      x >= this.spec.width ||
      y >= this.spec.height ||
      !Number.isInteger(channel) ||
      channel < 0 ||
      channel >= this.spec.channels
    ) {
      throw new RangeError(`pixel out of bounds: (${x}, ${y}, ch ${channel})`);
    }
  }
}

export async function readBufferData(buffer: RenderBuffer): Promise<BufferData> {
  const bytes = await buffer.readBytes();
  return { spec: buffer.spec, bytes };
}

/** Read a single element (channel 0 by default) from raw buffer bytes. */
export function readElement(
  bytes: Uint8Array,
  spec: BufferSpec,
  x: number,
  y: number,
  channel = 0,
): number {
  assertValidSpec(spec);
  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 ||
    y < 0 ||
    x >= spec.width ||
    y >= spec.height ||
    !Number.isInteger(channel) ||
    channel < 0 ||
    channel >= spec.channels
  ) {
    throw new RangeError(`pixel out of bounds: (${x}, ${y}, ch ${channel})`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offset = ((y * spec.width + x) * spec.channels + channel) * elementSize(spec.format);
  switch (spec.format) {
    case "f32":
      return view.getFloat32(offset, true);
    case "u16":
      return view.getUint16(offset, true);
    case "u32":
      return view.getUint32(offset, true);
    case "u8":
      return view.getUint8(offset);
  }
}

export interface LineSample {
  t: number;
  value: number;
}

/**
 * Sample a straight line across a buffer for height cross-sections.
 * Nearest-neighbor sampling, coordinates clamped to the buffer bounds.
 */
export function sampleLine(
  data: BufferData,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  samples = 16,
  channel = 0,
): LineSample[] {
  if (!Number.isInteger(samples) || samples < 2) {
    throw new RangeError("samples must be an integer >= 2");
  }
  const out: LineSample[] = [];
  for (let i = 0; i < samples; i++) {
    const t = i / (samples - 1);
    const x = Math.round(clampIndex(x0 + (x1 - x0) * t, data.spec.width));
    const y = Math.round(clampIndex(y0 + (y1 - y0) * t, data.spec.height));
    out.push({ t, value: readElement(data.bytes, data.spec, x, y, channel) });
  }
  return out;
}

function clampIndex(v: number, size: number): number {
  return v < 0 ? 0 : v >= size ? size - 1 : v;
}

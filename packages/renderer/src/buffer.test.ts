import { describe, expect, it } from "vitest";
import {
  HostBuffer,
  assertValidSpec,
  byteLength,
  elementSize,
  readElement,
  sampleLine,
} from "./buffer";
import type { BufferData, BufferSpec } from "./types";

describe("assertValidSpec", () => {
  it("rejects invalid dimensions, channels and formats", () => {
    expect(() => assertValidSpec({ width: 0, height: 4, channels: 1, format: "f32" })).toThrow();
    expect(() =>
      assertValidSpec({ width: 2.5, height: 4, channels: 1, format: "f32" }),
    ).toThrow();
    expect(() => assertValidSpec({ width: 2, height: -4, channels: 1, format: "f32" })).toThrow();
    expect(() => assertValidSpec({ width: 2, height: 4, channels: 5 as never, format: "f32" })).toThrow();
    expect(() =>
      assertValidSpec({ width: 2, height: 4, channels: 1, format: "f64" as never }),
    ).toThrow();
    expect(() => assertValidSpec({ width: 2, height: 4, channels: 3, format: "u8" })).not.toThrow();
  });
});

describe("byteLength / elementSize", () => {
  it("computes tight row-major byte counts", () => {
    const spec: BufferSpec = { width: 10, height: 4, channels: 3, format: "f32" };
    expect(elementSize("f32")).toBe(4);
    expect(elementSize("u16")).toBe(2);
    expect(elementSize("u32")).toBe(4);
    expect(elementSize("u8")).toBe(1);
    expect(byteLength(spec)).toBe(10 * 4 * 3 * 4);
  });
});

describe("HostBuffer", () => {
  it("get/set roundtrips per format", async () => {
    const spec: BufferSpec = { width: 2, height: 2, channels: 3, format: "f32" };
    const buf = new HostBuffer(spec);
    buf.set(1, 0, 2, 0.5);
    expect(buf.get(1, 0, 2)).toBe(0.5);
    expect(buf.get(0, 0, 0)).toBe(0);

    const bytes = await buf.readBytes();
    const data: BufferData = { spec, bytes };
    expect(readElement(bytes, spec, 1, 0, 2)).toBe(0.5);
    expect(data.bytes.byteLength).toBe(byteLength(spec));
  });

  it("writeBytes copies into the buffer", async () => {
    const spec: BufferSpec = { width: 2, height: 1, channels: 1, format: "u8" };
    const buf = new HostBuffer(spec);
    await buf.writeBytes(new Uint8Array([10, 20]));
    expect(buf.get(0, 0)).toBe(10);
    expect(buf.get(1, 0)).toBe(20);
  });

  it("throws on out-of-bounds pixels and oversized writes", async () => {
    const buf = new HostBuffer({ width: 2, height: 2, channels: 1, format: "f32" });
    expect(() => buf.get(2, 0)).toThrow();
    expect(() => buf.set(0, 0, 1, 1)).toThrow();
    await expect(buf.writeBytes(new Uint8Array(64))).rejects.toThrow();
  });

  it("readBytes returns a copy, not a live view", async () => {
    const buf = new HostBuffer({ width: 2, height: 1, channels: 1, format: "u8" });
    await buf.writeBytes(new Uint8Array([1, 2]));
    const first = await buf.readBytes();
    await buf.writeBytes(new Uint8Array([3, 4]));
    const second = await buf.readBytes();
    expect(Array.from(first)).toEqual([1, 2]);
    expect(Array.from(second)).toEqual([3, 4]);
  });
});

describe("sampleLine", () => {
  it("samples a horizontal cross-section", () => {
    const spec: BufferSpec = { width: 4, height: 1, channels: 1, format: "f32" };
    const buf = new HostBuffer(spec);
    buf.set(0, 0, 0, 0);
    buf.set(1, 0, 0, 1);
    buf.set(2, 0, 0, 2);
    buf.set(3, 0, 0, 3);
    const line = sampleLine({ spec, bytes: new Uint8Array(buf.data.buffer) }, 0, 0, 3, 0, 4);
    expect(line.map((s) => s.value)).toEqual([0, 1, 2, 3]);
  });

  it("clamps samples at the edges", () => {
    const spec: BufferSpec = { width: 2, height: 2, channels: 1, format: "f32" };
    const buf = new HostBuffer(spec);
    buf.set(0, 0, 0, 7);
    buf.set(1, 0, 0, 7);
    buf.set(0, 1, 0, 7);
    buf.set(1, 1, 0, 7);
    const line = sampleLine({ spec, bytes: new Uint8Array(buf.data.buffer) }, -5, 5, 5, -5, 2);
    expect(line).toHaveLength(2);
    expect(line.every((s) => s.value === 7)).toBe(true);
  });
});

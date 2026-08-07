import { describe, expect, it } from "vitest";
import { HostBuffer, sampleLine } from "../buffer";
import { toPpmBytes, toRgbaBytes } from "./export";
import type { BufferData, BufferSpec } from "../types";

function dataFrom(spec: BufferSpec, values: number[]): BufferData {
  const buf = new HostBuffer(spec);
  buf.data.set(values);
  return { spec, bytes: new Uint8Array(buf.data.buffer) };
}

describe("toRgbaBytes", () => {
  it("visualizes a height ramp as grayscale", () => {
    const spec: BufferSpec = { width: 2, height: 1, channels: 1, format: "f32" };
    const img = toRgbaBytes(dataFrom(spec, [0, 1]));
    expect(img.width).toBe(2);
    expect(img.height).toBe(1);
    expect(Array.from(img.data)).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
  });

  it("uses explicit min/max for height range", () => {
    const spec: BufferSpec = { width: 2, height: 1, channels: 1, format: "f32" };
    const img = toRgbaBytes(dataFrom(spec, [0.25, 0.75]), { min: 0, max: 1 });
    expect(img.data[0]).toBe(64);
    expect(img.data[4]).toBe(191);
  });

  it("maps NaN height to black instead of crashing", () => {
    const spec: BufferSpec = { width: 1, height: 1, channels: 1, format: "f32" };
    const img = toRgbaBytes(dataFrom(spec, [NaN]));
    expect(img.data[0]).toBe(0);
  });

  it("visualizes normals as xyz -> rgb", () => {
    const spec: BufferSpec = { width: 1, height: 1, channels: 3, format: "f32" };
    const img = toRgbaBytes(dataFrom(spec, [-1, 0, 1]));
    expect(Array.from(img.data)).toEqual([0, 128, 255, 255]);
  });

  it("passes RGBA8 color through", () => {
    const spec: BufferSpec = { width: 1, height: 1, channels: 4, format: "u8" };
    const img = toRgbaBytes(dataFrom(spec, [10, 20, 30, 200]));
    expect(Array.from(img.data)).toEqual([10, 20, 30, 200]);
  });

  it("auto-detects color vs normal vs height", () => {
    const color = toRgbaBytes(dataFrom({ width: 1, height: 1, channels: 3, format: "u8" }, [1, 2, 3]));
    expect(Array.from(color.data)).toEqual([1, 2, 3, 255]);
    const normal = toRgbaBytes(dataFrom({ width: 1, height: 1, channels: 3, format: "f32" }, [1, 1, 1]));
    expect(Array.from(normal.data)).toEqual([255, 255, 255, 255]);
    const height = toRgbaBytes(dataFrom({ width: 1, height: 1, channels: 1, format: "f32" }, [0.5]));
    expect(Array.from(height.data)).toEqual([128, 128, 128, 255]);
  });
});

describe("toPpmBytes", () => {
  it("encodes a binary P6 PPM", () => {
    const spec: BufferSpec = { width: 2, height: 2, channels: 4, format: "u8" };
    const img = toRgbaBytes(dataFrom(spec, Array(16).fill(0).map((_, i) => (i % 4 === 3 ? 255 : i % 4 === 0 ? 255 : 0))));
    const ppm = toPpmBytes(img);
    const header = new TextDecoder().decode(ppm.subarray(0, 11));
    expect(header).toBe("P6\n2 2\n255\n");
    expect(ppm.byteLength).toBe(11 + 2 * 2 * 3);
    expect(ppm[11]).toBe(255);
  });

  it("roundtrips through an actual file", async () => {
    const { writeFile, mkdtemp, rm, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "ukibori-ppm-"));
    try {
      const img = toRgbaBytes(
        dataFrom({ width: 1, height: 1, channels: 4, format: "u8" }, [200, 100, 50, 255]),
      );
      const path = join(dir, "out.ppm");
      await writeFile(path, toPpmBytes(img));
      const file = await readFile(path);
      expect(new TextDecoder().decode(file.subarray(0, 2))).toBe("P6");
      expect(file.byteLength).toBe(11 + 3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("sampleLine with debug data", () => {
  it("reads height cross-sections", () => {
    const spec: BufferSpec = { width: 4, height: 1, channels: 1, format: "f32" };
    const line = sampleLine(dataFrom(spec, [0, 2, 4, 8]), 0, 0, 3, 0, 4);
    expect(line.map((s) => s.value)).toEqual([0, 2, 4, 8]);
  });
});

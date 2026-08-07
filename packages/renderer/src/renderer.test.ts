import { describe, expect, it } from "vitest";
import { COLOR_SPEC, HEIGHT_SPEC, NORMAL_SPEC, OBJECT_ID_SPEC, VISIBILITY_SPEC } from "./types";
import {
  UkiboriRenderer,
  createRenderer,
  testPatternBytes,
} from "./renderer";
import { byteLength, readElement } from "./buffer";
import type { BufferSpec } from "./types";

describe("testPatternBytes", () => {
  it("is deterministic", () => {
    const spec: BufferSpec = { width: 4, height: 3, channels: 3, format: "f32" };
    const a = testPatternBytes(spec);
    const b = testPatternBytes(spec);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("produces finite values with the documented byte length", () => {
    const spec: BufferSpec = { width: 8, height: 6, channels: 2, format: "f32" };
    const bytes = testPatternBytes(spec);
    expect(bytes.byteLength).toBe(byteLength(spec));
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < bytes.byteLength; i += 4) {
      expect(Number.isFinite(view.getFloat32(i, true))).toBe(true);
    }
  });

  it("builds x ramps and checkerboards", () => {
    const ramp = testPatternBytes({ width: 2, height: 1, channels: 1, format: "f32" });
    expect(new DataView(ramp.buffer).getFloat32(0, true)).toBeCloseTo(0.25);
    expect(new DataView(ramp.buffer).getFloat32(4, true)).toBeCloseTo(0.75);

    const check = testPatternBytes({ width: 2, height: 2, channels: 4, format: "u8" });
    expect(check[0]).toBe(255);
    expect(check[4]).toBe(72);
  });
});

describe("UkiboriRenderer", () => {
  it("ensures targets once and reuses them", async () => {
    const { renderer } = await createRenderer({ backend: "cpu" });
    const a = await renderer.ensureTarget("height", HEIGHT_SPEC(8, 8));
    const b = await renderer.ensureTarget("height", HEIGHT_SPEC(8, 8));
    expect(a).toBe(b);
    const c = await renderer.ensureTarget("height", HEIGHT_SPEC(16, 8));
    expect(c).not.toBe(a);
    expect(renderer.getTarget("height")).toBe(c);
    renderer.dispose();
  });

  it("renderTestPattern fills targets readably", async () => {
    const { renderer } = await createRenderer({ backend: "cpu" });
    await renderer.ensureTarget("height", HEIGHT_SPEC(4, 2));
    await renderer.renderTestPattern();
    const height = renderer.getTarget("height");
    const bytes = await height!.readBytes();
    expect(readElement(bytes, height!.spec, 0, 0)).toBeCloseTo(0.125);
    expect(readElement(bytes, height!.spec, 3, 0)).toBeCloseTo(0.875);
    renderer.dispose();
  });

  it("auto backend selection falls back to CPU without WebGPU", async () => {
    const { renderer, capabilities, backend } = await createRenderer();
    expect(backend.kind).toBe("cpu");
    expect(capabilities.backend).toBe("cpu");
    renderer.dispose();
  });

  it("throws when WebGPU is explicitly requested but unavailable", async () => {
    await expect(createRenderer({ backend: "webgpu" })).rejects.toThrow();
  });
});

describe("semantic buffer specs", () => {
  it("documents the scene contract formats", () => {
    expect(HEIGHT_SPEC(2, 2).format).toBe("f32");
    expect(HEIGHT_SPEC(2, 2).channels).toBe(1);
    expect(NORMAL_SPEC(2, 2).channels).toBe(3);
    expect(OBJECT_ID_SPEC(2, 2).format).toBe("u32");
    expect(VISIBILITY_SPEC(2, 2).format).toBe("f32");
    expect(COLOR_SPEC(2, 2).channels).toBe(4);
    expect(COLOR_SPEC(2, 2).format).toBe("u8");
  });
});

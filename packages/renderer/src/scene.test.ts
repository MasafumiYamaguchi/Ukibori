import { describe, expect, it } from "vitest";
import { createScene } from "./scene";
import type { SurfaceNode } from "./scene";

const flat = { kind: "flat" } as const;

function surface(partial: Partial<SurfaceNode> = {}): SurfaceNode {
  return {
    id: "a",
    position: { x: 0, y: 0 },
    size: { x: 10, y: 10 },
    elevation: 1,
    shape: { kind: "roundedRect", radius: 0 },
    profile: flat,
    material: "silicone",
    castsShadow: true,
    receivesShadow: true,
    ...partial,
  };
}

describe("createScene", () => {
  it("builds a scene fixture without React or DOM", () => {
    const scene = createScene({
      width: 100,
      height: 80,
      surfaces: [surface()],
      light: { direction: { x: -0.6, y: -0.8, z: 1 }, intensity: 2 },
    });
    expect(scene.width).toBe(100);
    expect(scene.height).toBe(80);
    expect(scene.surfaces).toHaveLength(1);
    const d = scene.light.direction;
    expect(Math.hypot(d.x, d.y, d.z)).toBeCloseTo(1, 12);
  });

  it("defaults thickness, bevelWidth, light direction and intensity", () => {
    const scene = createScene({ width: 4, height: 4, surfaces: [surface()] });
    expect(scene.surfaces[0].thickness).toBe(0);
    expect(scene.surfaces[0].bevelWidth).toBe(0);
    expect(scene.light.direction).toEqual({ x: 0, y: 0, z: 1 });
    expect(scene.light.intensity).toBe(1);
  });

  it("keeps a provided bevelWidth", () => {
    const scene = createScene({
      width: 4,
      height: 4,
      surfaces: [surface({ bevelWidth: 2.5 })],
    });
    expect(scene.surfaces[0].bevelWidth).toBe(2.5);
  });

  it("normalizes the light direction toward the light", () => {
    const scene = createScene({
      width: 4,
      height: 4,
      light: { direction: { x: 0, y: 0, z: 5 } },
    });
    expect(scene.light.direction).toEqual({ x: 0, y: 0, z: 1 });
  });

  it("falls back to +z for invalid or zero directions", () => {
    for (const direction of [
      { x: 0, y: 0, z: 0 },
      { x: NaN, y: 0, z: 1 },
      { x: Infinity, y: 0, z: 1 },
      undefined,
    ]) {
      const scene = createScene({ width: 4, height: 4, light: { direction } as never });
      expect(scene.light.direction).toEqual({ x: 0, y: 0, z: 1 });
    }
  });

  it("sanitizes intensity to 1 when invalid, keeps valid values", () => {
    expect(createScene({ width: 4, height: 4, light: { intensity: NaN } }).light.intensity).toBe(1);
    expect(createScene({ width: 4, height: 4, light: { intensity: -3 } }).light.intensity).toBe(1);
    expect(createScene({ width: 4, height: 4, light: { intensity: 0 } }).light.intensity).toBe(0);
    expect(createScene({ width: 4, height: 4, light: { intensity: 2.5 } }).light.intensity).toBe(2.5);
  });

  it("throws on invalid scene dimensions", () => {
    expect(() => createScene({ width: 0, height: 4 })).toThrow(TypeError);
    expect(() => createScene({ width: 4.5, height: 4 })).toThrow(TypeError);
    expect(() => createScene({ width: -4, height: 4 })).toThrow(TypeError);
    expect(() => createScene({ width: NaN, height: 4 })).toThrow(TypeError);
  });

  it("throws on structural surface violations", () => {
    const base = { width: 4, height: 4 };
    expect(() => createScene({ ...base, surfaces: [surface({ id: "" })] })).toThrow(TypeError);
    expect(() => createScene({ ...base, surfaces: [surface({ elevation: -1 })] })).toThrow(TypeError);
    expect(() => createScene({ ...base, surfaces: [surface({ elevation: NaN })] })).toThrow(TypeError);
    expect(() => createScene({ ...base, surfaces: [surface({ thickness: -0.5 })] })).toThrow(TypeError);
    expect(() => createScene({ ...base, surfaces: [surface({ bevelWidth: -1 })] })).toThrow(TypeError);
    expect(() => createScene({ ...base, surfaces: [surface({ bevelWidth: NaN })] })).toThrow(TypeError);
    expect(() => createScene({ ...base, surfaces: [surface({ size: { x: 0, y: 10 } })] })).toThrow(
      RangeError,
    );
    expect(() => createScene({ ...base, surfaces: [surface({ size: { x: NaN, y: 10 } })] })).toThrow(
      TypeError,
    );
    expect(() => createScene({ ...base, surfaces: [surface({ shape: { kind: "roundedRect", radius: -1 } })] })).toThrow(TypeError);
    expect(() => createScene({ ...base, surfaces: [surface({ material: "" })] })).toThrow(TypeError);
    expect(() =>
      createScene({ ...base, surfaces: [surface({ castsShadow: 1 as never })] }),
    ).toThrow(TypeError);
  });

  it("rejects unknown or non-descriptor profiles", () => {
    const base = { width: 4, height: 4 };
    expect(() =>
      createScene({ ...base, surfaces: [surface({ profile: { kind: "smoothStep" } as never })] }),
    ).toThrow(TypeError);
    expect(() =>
      createScene({ ...base, surfaces: [surface({ profile: (() => 0) as never })] }),
    ).toThrow(TypeError);
    expect(() => createScene({ ...base, surfaces: [surface({ profile: null as never })] })).toThrow(
      TypeError,
    );
    expect(() => createScene({ ...base, surfaces: [surface({ profile: flat })] })).not.toThrow();
    expect(() =>
      createScene({ ...base, surfaces: [surface({ profile: { kind: "bevel" } })] }),
    ).not.toThrow();
  });

  it("throws on duplicate surface ids", () => {
    expect(() =>
      createScene({ width: 4, height: 4, surfaces: [surface(), surface({ position: { x: 5, y: 5 } })] }),
    ).toThrow(/duplicate surface id "a"/);
  });

  it("rejects unknown or malformed shapes", () => {
    const base = { width: 4, height: 4 };
    expect(() =>
      createScene({ ...base, surfaces: [surface({ shape: { kind: "polygon" } as never })] }),
    ).toThrow(TypeError);
    expect(() => createScene({ ...base, surfaces: [surface({ shape: null as never })] })).toThrow(
      TypeError,
    );
    expect(() =>
      createScene({ ...base, surfaces: [surface({ shape: (() => 0) as never })] }),
    ).toThrow(TypeError);
    expect(() =>
      createScene({ ...base, surfaces: [surface({ shape: { kind: "roundedRect" } as never })] }),
    ).toThrow(TypeError);
    expect(() =>
      createScene({ ...base, surfaces: [surface({ shape: { kind: "roundedRect", radius: NaN } })] }),
    ).toThrow(TypeError);
    expect(() => createScene({ ...base, surfaces: [surface({ shape: { kind: "mask" } })] })).not.toThrow();
  });

  it("accepts mask shapes and returns normalized surfaces with thickness", () => {
    const scene = createScene({
      width: 4,
      height: 4,
      surfaces: [surface({ shape: { kind: "mask" }, thickness: 3 })],
    });
    expect(scene.surfaces[0].shape.kind).toBe("mask");
    expect(scene.surfaces[0].thickness).toBe(3);
  });
});

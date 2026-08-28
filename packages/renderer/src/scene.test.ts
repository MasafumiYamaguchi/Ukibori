import { describe, expect, it } from "vitest";
import { maskFromAscii } from "./mask";
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

  // #45 directional-light color sanitization: linear RGB, default white,
  // HDR values above 1 preserved, invalid channels fall back to 1.
  it("defaults the directional-light color to white", () => {
    expect(createScene({ width: 4, height: 4 }).light.color).toEqual({ r: 1, g: 1, b: 1 });
    expect(
      createScene({ width: 4, height: 4, light: { direction: { x: 0, y: 0, z: 1 } } }).light.color,
    ).toEqual({ r: 1, g: 1, b: 1 });
  });

  it("preserves valid finite non-negative channels including zero and HDR values", () => {
    const scene = createScene({
      width: 4,
      height: 4,
      light: { color: { r: 1, g: 0, b: 2 } },
    });
    expect(scene.light.color).toEqual({ r: 1, g: 0, b: 2 });
  });

  it("falls back per channel to 1 for missing / non-finite / negative values", () => {
    // the issue's example: { r: NaN, g: 0.5, b: 2 } -> { r: 1, g: 0.5, b: 2 }
    expect(createScene({ width: 4, height: 4, light: { color: { r: NaN, g: 0.5, b: 2 } } }).light.color).toEqual({
      r: 1,
      g: 0.5,
      b: 2,
    });
    for (const bad of [NaN, Infinity, -Infinity, -1]) {
      expect(
        createScene({ width: 4, height: 4, light: { color: { r: bad, g: 0.4, b: 0.6 } } as never })
          .light.color,
      ).toEqual({ r: 1, g: Math.fround(0.4), b: Math.fround(0.6) });
    }
    // missing channels (a partial color object) fill with white
    expect(createScene({ width: 4, height: 4, light: { color: { r: 0.3 } } as never }).light.color).toEqual({
      r: Math.fround(0.3),
      g: 1,
      b: 1,
    });
  });

  // #45 f32-domain contract: Scene.light.color is the CANONICAL f32 value —
  // the exact number the encoder packs and the WGSL shader reads. A channel
  // that is legal in the JS f64 domain but not representable as an f32
  // (Math.fround -> Infinity) must fall back to 1 AT SANITIZE TIME, so the
  // public API can never produce a value the GPU ABI cannot hold.
  it("rounds every valid channel to its canonical f32 value", () => {
    expect(
      createScene({
        width: 4,
        height: 4,
        light: { color: { r: 0.1, g: 0.2, b: 0.3 } },
      }).light.color,
    ).toEqual({
      r: Math.fround(0.1),
      g: Math.fround(0.2),
      b: Math.fround(0.3),
    });
  });

  it("preserves representable HDR channels and the largest finite f32", () => {
    expect(
      createScene({
        width: 4,
        height: 4,
        light: { color: { r: 2, g: 16, b: 65504 } },
      }).light.color,
    ).toEqual({ r: 2, g: 16, b: 65504 });
    // the largest finite f32 (f32-exact in JS): preserved, finite
    const nearMax = 3.4028234663852886e38;
    const scene = createScene({
      width: 4,
      height: 4,
      light: { color: { r: nearMax, g: 1, b: 1 } },
    });
    expect(scene.light.color.r).toBe(nearMax);
    expect(Number.isFinite(scene.light.color.r)).toBe(true);
  });

  it("falls back to 1 for finite f64 values whose f32 rounding overflows", () => {
    // Math.fround(Number.MAX_VALUE) === Infinity: the canonical f32 value
    // cannot exist, so the sanitizer must fall back to 1 instead of
    // creating a CPU-valid / GPU-invalid split.
    expect(
      createScene({ width: 4, height: 4, light: { color: { r: Number.MAX_VALUE, g: 1, b: 1 } } })
        .light.color,
    ).toEqual({ r: 1, g: 1, b: 1 });
    // 3.4028236e38 is above the f32 rounding-overflow boundary
    expect(Math.fround(3.4028236e38)).toBe(Infinity);
    expect(
      createScene({ width: 4, height: 4, light: { color: { r: 3.4028236e38, g: 1, b: 1 } } })
        .light.color,
    ).toEqual({ r: 1, g: 1, b: 1 });
    // just below the boundary stays a finite representable HDR value
    expect(Math.fround(3.4028234e38)).not.toBe(Infinity);
    expect(
      createScene({ width: 4, height: 4, light: { color: { r: 3.4028234e38, g: 1, b: 1 } } })
        .light.color.r,
    ).toBe(Math.fround(3.4028234e38));
  });

  it("keeps zero as an explicit valid black-light channel", () => {
    expect(
      createScene({ width: 4, height: 4, light: { color: { r: 0, g: 0, b: 0 } } }).light.color,
    ).toEqual({ r: 0, g: 0, b: 0 });
  });

  it("defaults environment to 0.5 and exposure to 1", () => {
    const scene = createScene({ width: 4, height: 4 });
    expect(scene.environment).toEqual({
      intensity: 0.5,
      diffuseIntensity: 1,
      specularIntensity: 1,
    });
    expect(scene.exposure).toBe(1);
  });

  it("keeps valid environment intensity and exposure, preserving zero", () => {
    const scene = createScene({ width: 4, height: 4, environment: { intensity: 0 }, exposure: 0 });
    expect(scene.environment.intensity).toBe(0);
    expect(scene.exposure).toBe(0);
    const scene2 = createScene({ width: 4, height: 4, environment: { intensity: 2 }, exposure: 3.5 });
    expect(scene2.environment.intensity).toBe(2);
    expect(scene2.exposure).toBe(3.5);
  });

  it("falls back to defaults for invalid environment intensity and exposure", () => {
    for (const intensity of [NaN, Infinity, -Infinity, -1]) {
      expect(
        createScene({ width: 4, height: 4, environment: { intensity } as never }).environment.intensity,
      ).toBe(0.5);
    }
    for (const exposure of [NaN, Infinity, -Infinity, -1]) {
      expect(createScene({ width: 4, height: 4, exposure } as never).exposure).toBe(1);
    }
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
    // mask without a source, and malformed mask sources
    expect(() => createScene({ ...base, surfaces: [surface({ shape: { kind: "mask" } as never })] })).toThrow(TypeError);
    expect(() =>
      createScene({
        ...base,
        surfaces: [
          surface({
            shape: { kind: "mask", mask: { width: 2, height: 2, alpha: new Float32Array(3) } },
          }),
        ],
      }),
    ).toThrow(TypeError);
    expect(() =>
      createScene({
        ...base,
        surfaces: [surface({ shape: { kind: "mask", mask: { width: 0, height: 2, alpha: new Float32Array(0) } } })],
      }),
    ).toThrow(TypeError);
    expect(() => createScene({ ...base, surfaces: [surface({ shape: { kind: "mask", mask: maskFromAscii(["#"]) } })] })).not.toThrow();
  });

  it("rejects out-of-range Float32 alpha values", () => {
    const base = { width: 4, height: 4 };
    expect(() =>
      createScene({
        ...base,
        surfaces: [surface({ shape: { kind: "mask", mask: { width: 1, height: 1, alpha: new Float32Array([1.5]) } } })],
      }),
    ).toThrow(TypeError);
    expect(() =>
      createScene({
        ...base,
        surfaces: [surface({ shape: { kind: "mask", mask: { width: 1, height: 1, alpha: new Float32Array([-0.1]) } } })],
      }),
    ).toThrow(TypeError);
  });

  it("rejects non-isotropic mask mappings", () => {
    const base = { width: 4, height: 4 };
    // 2x2 mask mapped onto a 10x5 surface: aspect 1 != 2
    expect(() =>
      createScene({
        ...base,
        surfaces: [surface({ shape: { kind: "mask", mask: maskFromAscii(["##", "##"]) }, size: { x: 10, y: 5 } })],
      }),
    ).toThrow(/isotropic/);
    expect(() =>
      createScene({
        ...base,
        surfaces: [surface({ shape: { kind: "mask", mask: maskFromAscii(["##", "##"]) }, size: { x: 10, y: 10 } })],
      }),
    ).not.toThrow();
  });

  it("rejects unknown material references", () => {
    expect(() =>
      createScene({
        width: 4,
        height: 4,
        surfaces: [surface({ material: "nope" })],
      }),
    ).toThrow(/unknown material "nope"/);
  });

  it("accepts scene material overrides and sanitizes them", () => {
    const scene = createScene({
      width: 4,
      height: 4,
      surfaces: [surface({ material: "custom" })],
      materials: {
        custom: { baseColor: { r: 0.1, g: 0.2, b: 0.3 }, roughness: 5, metallic: -1 },
      },
    });
    expect(scene.materials?.["custom"].roughness).toBe(1);
    expect(scene.materials?.["custom"].metallic).toBe(0);
    expect(scene.materials?.["custom"].baseColor.r).toBe(0.1);
  });

  it("accepts mask shapes and returns normalized surfaces with thickness", () => {
    const scene = createScene({
      width: 4,
      height: 4,
      surfaces: [surface({ shape: { kind: "mask", mask: maskFromAscii(["##", "##"]) }, thickness: 3 })],
    });
    expect(scene.surfaces[0].shape.kind).toBe("mask");
    expect(scene.surfaces[0].thickness).toBe(3);
  });
});

import { describe, expect, it } from "vitest";
import { HostBuffer, readElement } from "./buffer";
import { lightScene, computeNormals, shadeHeightField } from "./lighting";
import { createScene } from "./scene";
import type { Scene, SurfaceNode } from "./scene";

function heightFrom(values: number[][], width: number, height: number): HostBuffer {
  const buf = new HostBuffer({ width, height, channels: 1, format: "f32" });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      buf.set(x, y, 0, values[y][x]);
    }
  }
  return buf;
}

const bevel = { kind: "bevel" } as const;

function buttonScene(light: { x: number; y: number }): Scene {
  return createScene({
    width: 16,
    height: 16,
    surfaces: [
      {
        id: "btn",
        position: { x: 3, y: 3 },
        size: { x: 10, y: 10 },
        elevation: 0,
        thickness: 2,
        bevelWidth: 2,
        shape: { kind: "roundedRect", radius: 2 },
        profile: bevel,
        material: "silicone",
        castsShadow: true,
        receivesShadow: true,
      },
    ],
    light: { direction: { x: light.x, y: light.y, z: 1 }, intensity: 1 },
  });
}

describe("computeNormals", () => {
  it("points +z on a flat height field", () => {
    const flat = heightFrom(
      Array.from({ length: 4 }, () => Array(4).fill(0)),
      4,
      4,
    );
    const normal = computeNormals(flat);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        expect(normal.get(x, y, 0)).toBeCloseTo(0, 12);
        expect(normal.get(x, y, 1)).toBeCloseTo(0, 12);
        expect(normal.get(x, y, 2)).toBeCloseTo(1, 12);
      }
    }
  });

  it("tilts against the x gradient (ramp H = x)", () => {
    // H(x) = x: dx = 2 per pixel -> N = normalize(-1, 0, 1)
    const ramp = heightFrom(
      [
        [0, 1, 2, 3],
        [0, 1, 2, 3],
        [0, 1, 2, 3],
        [0, 1, 2, 3],
      ],
      4,
      4,
    );
    const normal = computeNormals(ramp);
    const expected = { x: -1 / Math.SQRT2, y: 0, z: 1 / Math.SQRT2 };
    // interior pixels use the symmetric central difference;
    // normals are stored as f32 (#13 semantics), so tolerance is ~1e-6
    expect(normal.get(1, 1, 0)).toBeCloseTo(expected.x, 6);
    expect(normal.get(1, 1, 1)).toBeCloseTo(0, 6);
    expect(normal.get(1, 1, 2)).toBeCloseTo(expected.z, 6);
  });

  it("tilts diagonally for H = x + y", () => {
    const diag = heightFrom(
      [
        [0, 1, 2, 3],
        [1, 2, 3, 4],
        [2, 3, 4, 5],
        [3, 4, 5, 6],
      ],
      4,
      4,
    );
    const normal = computeNormals(diag);
    const len = Math.hypot(1, 1, 1);
    expect(normal.get(1, 1, 0)).toBeCloseTo(-1 / len, 6);
    expect(normal.get(1, 1, 1)).toBeCloseTo(-1 / len, 6);
    expect(normal.get(1, 1, 2)).toBeCloseTo(1 / len, 6);
  });

  it("produces unit-length, finite normals everywhere on a bevel scene", () => {
    const scene = buttonScene({ x: -0.6, y: -0.8 });
    const { height } = lightScene(scene);
    const normal = computeNormals(height);
    const bytes = new Uint8Array(normal.data.buffer);
    for (let y = 0; y < normal.spec.height; y++) {
      for (let x = 0; x < normal.spec.width; x++) {
        const nx = readElement(bytes, normal.spec, x, y, 0);
        const ny = readElement(bytes, normal.spec, x, y, 1);
        const nz = readElement(bytes, normal.spec, x, y, 2);
        expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 6);
        expect(Number.isFinite(nx)).toBe(true);
      }
    }
  });

  it("sanitizes normalScale: zero, negative and non-finite fall back to a strictly positive value", () => {
    const flat = heightFrom(
      Array.from({ length: 4 }, () => Array(4).fill(0)),
      4,
      4,
    );
    for (const normalScale of [0, -1, NaN, Infinity, -Infinity]) {
      const normal = computeNormals(flat, { normalScale });
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) {
          expect(normal.get(x, y, 0)).toBeCloseTo(0, 6);
          expect(normal.get(x, y, 1)).toBeCloseTo(0, 6);
          expect(normal.get(x, y, 2)).toBeCloseTo(1, 6);
        }
      }
    }
  });

  it("stays finite and unit-length with extreme scale values", () => {
    const ramp = heightFrom(
      [
        [0, 1, 2, 3],
        [0, 1, 2, 3],
        [0, 1, 2, 3],
        [0, 1, 2, 3],
      ],
      4,
      4,
    );
    const normal = computeNormals(ramp, { scaleX: 1e200, scaleY: 1e200, normalScale: 1e-200 });
    const bytes = new Uint8Array(normal.data.buffer);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const nx = readElement(bytes, normal.spec, x, y, 0);
        const ny = readElement(bytes, normal.spec, x, y, 1);
        const nz = readElement(bytes, normal.spec, x, y, 2);
        expect(Number.isFinite(nx)).toBe(true);
        expect(Number.isFinite(ny)).toBe(true);
        expect(Number.isFinite(nz)).toBe(true);
        expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 5);
      }
    }
  });

  it("keeps the flat plateau interior at +z on a real bevel surface", () => {
    const scene = buttonScene({ x: 0, y: 0 });
    const { height } = lightScene(scene);
    const normal = computeNormals(height);
    // center plateau pixel: d = -4.5, beyond the bevel band -> flat
    expect(normal.get(8, 8, 0)).toBeCloseTo(0, 4);
    expect(normal.get(8, 8, 1)).toBeCloseTo(0, 4);
    expect(normal.get(8, 8, 2)).toBeCloseTo(1, 4);
  });

  it("tilts normals on bevel edges", () => {
    const scene = buttonScene({ x: 0, y: 0 });
    const { height } = lightScene(scene);
    const normal = computeNormals(height);
    // left edge pixel (4, 8): height rises toward +x -> normal tilts toward -x
    expect(normal.get(4, 8, 0)).toBeLessThan(0);
    expect(normal.get(4, 8, 2)).toBeLessThan(1);
    // right edge pixel (12, 8): mirror
    expect(normal.get(12, 8, 0)).toBeGreaterThan(0);
  });
});

describe("shading", () => {
  it("fully lights a flat surface facing a +z light", () => {
    const scene = createScene({
      width: 4,
      height: 4,
      light: { direction: { x: 0, y: 0, z: 1 }, intensity: 1 },
    });
    const flat = heightFrom(
      Array.from({ length: 4 }, () => Array(4).fill(0)),
      4,
      4,
    );
    const { diffuse } = shadeHeightField(scene, flat);
    expect(diffuse.get(1, 1)).toBeCloseTo(1, 12);
  });

  it("scales diffuse with the light tilt", () => {
    const scene = createScene({
      width: 4,
      height: 4,
      light: { direction: { x: 0.6, y: 0, z: 0.8 }, intensity: 1 },
    });
    const flat = heightFrom(
      Array.from({ length: 4 }, () => Array(4).fill(0)),
      4,
      4,
    );
    const { diffuse } = shadeHeightField(scene, flat);
    expect(diffuse.get(1, 1)).toBeCloseTo(0.8, 6);
  });

  it("slides the highlight across the bevel when the light moves (not an offset)", () => {
    const left = lightScene(buttonScene({ x: -0.6, y: 0 })).diffuse;
    const right = lightScene(buttonScene({ x: 0.6, y: 0 })).diffuse;
    const row = 8; // horizontal center row through the button
    const argmaxX = (buf: HostBuffer): number => {
      let bestX = 0;
      let best = -Infinity;
      for (let x = 0; x < buf.spec.width; x++) {
        const v = buf.get(x, row, 0);
        if (v > best) {
          best = v;
          bestX = x;
        }
      }
      return bestX;
    };
    const leftX = argmaxX(left);
    const rightX = argmaxX(right);
    expect(leftX).toBeLessThan(8); // bright on the left bevel
    expect(rightX).toBeGreaterThan(8); // bright on the right bevel
    expect(leftX).not.toBe(rightX);
  });

  it("lighting is deterministic", () => {
    const a = lightScene(buttonScene({ x: -0.6, y: -0.8 }));
    const b = lightScene(buttonScene({ x: -0.6, y: -0.8 }));
    expect(Array.from(a.color.data)).toEqual(Array.from(b.color.data));
    expect(Array.from(a.normal.data)).toEqual(Array.from(b.normal.data));
  });

  it("emits valid RGBA8 color with finite values everywhere", () => {
    const { color, diffuse, specular } = lightScene(buttonScene({ x: -0.6, y: -0.8 }));
    for (let y = 0; y < color.spec.height; y++) {
      for (let x = 0; x < color.spec.width; x++) {
        for (let c = 0; c < 4; c++) {
          const v = color.get(x, y, c);
          expect(Number.isInteger(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(255);
        }
        expect(Number.isFinite(diffuse.get(x, y, 0))).toBe(true);
        expect(Number.isFinite(specular.get(x, y, 0))).toBe(true);
      }
    }
    expect(color.get(8, 8, 3)).toBe(255);
  });

  it("brightens toward the light on the bevel (combined color)", () => {
    const left = lightScene(buttonScene({ x: -0.6, y: 0 })).color;
    const right = lightScene(buttonScene({ x: 0.6, y: 0 })).color;
    const lum = (buf: HostBuffer, x: number, y: number) =>
      (buf.get(x, y, 0) + buf.get(x, y, 1) + buf.get(x, y, 2)) / 3;
    // left-light scene is brighter on the left edge than the right edge
    expect(lum(left, 4, 8)).toBeGreaterThan(lum(left, 12, 8));
    // and the right-light scene inverts it
    expect(lum(right, 12, 8)).toBeGreaterThan(lum(right, 4, 8));
  });

  it("sanitizes invalid shading options", () => {
    const scene = buttonScene({ x: 0, y: 0 });
    const a = shadeHeightField(scene, lightScene(scene).height, {
      shading: {
        baseColor: { r: NaN, g: 0.5, b: 0.5 },
        ambient: -1,
        diffuseStrength: Infinity,
        specularPower: -5,
      },
    });
    const b = shadeHeightField(scene, lightScene(scene).height);
    expect(Array.from(a.color.data)).toEqual(Array.from(b.color.data));
  });

  it("applies light intensity to direct diffuse/specular lighting", () => {
    const sceneAt = (intensity: number) =>
      createScene({
        ...buttonScene({ x: -0.6, y: -0.8 }),
        light: { direction: { x: -0.6, y: -0.8, z: 1 }, intensity },
      });
    const zero = lightScene(sceneAt(0)).color;
    const half = lightScene(sceneAt(0.5)).color;
    const full = lightScene(sceneAt(1)).color;
    const lum = (buf: HostBuffer, x: number, y: number) =>
      (buf.get(x, y, 0) + buf.get(x, y, 1) + buf.get(x, y, 2)) / 3;
    const litPixel = { x: 4, y: 8 }; // bright bevel pixel under this light
    // intensity 0: ambient only -> uniform color, no lighting gradient
    for (let y = 0; y < zero.spec.height; y++) {
      for (let x = 0; x < zero.spec.width; x++) {
        expect(Array.from([zero.get(x, y, 0), zero.get(x, y, 1), zero.get(x, y, 2)])).toEqual([
          zero.get(litPixel.x, litPixel.y, 0),
          zero.get(litPixel.x, litPixel.y, 1),
          zero.get(litPixel.x, litPixel.y, 2),
        ]);
      }
    }
    // ambient-only baseline is darker than any direct-lit pixel
    expect(lum(zero, litPixel.x, litPixel.y)).toBeLessThan(lum(full, litPixel.x, litPixel.y));
    // changing intensity changes the combined result monotonically
    expect(lum(half, litPixel.x, litPixel.y)).toBeGreaterThan(lum(zero, litPixel.x, litPixel.y));
    expect(lum(half, litPixel.x, litPixel.y)).toBeLessThan(lum(full, litPixel.x, litPixel.y));
    // diffuse term scales with intensity
    const dHalf = lightScene(sceneAt(0.5)).diffuse;
    const dFull = lightScene(sceneAt(1)).diffuse;
    expect(dHalf.get(litPixel.x, litPixel.y, 0)).toBe(dFull.get(litPixel.x, litPixel.y, 0));
  });

  it("resolves the degenerate half-vector L = -V without NaN", () => {
    const scene = createScene({
      ...buttonScene({ x: 0, y: 0 }),
      light: { direction: { x: 0, y: 0, z: -1 }, intensity: 1 },
    });
    const { color, diffuse, specular } = lightScene(scene);
    for (let y = 0; y < color.spec.height; y++) {
      for (let x = 0; x < color.spec.width; x++) {
        expect(Number.isFinite(diffuse.get(x, y, 0))).toBe(true);
        expect(Number.isFinite(specular.get(x, y, 0))).toBe(true);
        expect(specular.get(x, y, 0)).toBe(0); // no half vector -> no specular
        for (let c = 0; c < 4; c++) {
          expect(Number.isFinite(color.get(x, y, c))).toBe(true);
        }
      }
    }
    // normals point +z, light points -z -> no direct diffuse either
    for (let y = 0; y < diffuse.spec.height; y++) {
      for (let x = 0; x < diffuse.spec.width; x++) {
        expect(diffuse.get(x, y, 0)).toBe(0);
      }
    }
  });
});

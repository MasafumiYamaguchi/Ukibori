import { describe, expect, it } from "vitest";
import { HostBuffer, readElement, sampleLine } from "./buffer";
import { NO_OWNER } from "./compose";
import {
  composeSdfHeightField,
  generateSdfDebug,
  roundedRectSdf,
  roundedRectSurfaceHeight,
} from "./geometry";
import { createScene } from "./scene";
import type { Scene, SurfaceNode } from "./scene";

const bevel = { kind: "bevel" } as const;

function surface(partial: Partial<SurfaceNode> = {}): SurfaceNode {
  return {
    id: "btn",
    position: { x: 3, y: 3 },
    size: { x: 10, y: 10 },
    elevation: 6,
    thickness: 2,
    bevelWidth: 2,
    shape: { kind: "roundedRect", radius: 2 },
    profile: bevel,
    material: "silicone",
    castsShadow: true,
    receivesShadow: true,
    ...partial,
  };
}

function sceneWith(...surfaces: SurfaceNode[]): Scene {
  return createScene({ width: 16, height: 16, surfaces });
}

describe("roundedRectSdf", () => {
  const position = { x: 0, y: 0 };
  const size = { x: 10, y: 10 };
  const radius = 2;

  it("is negative inside, zero on the boundary, positive outside", () => {
    // center (5, 5): nearest boundary is the flat edge at distance 5
    expect(roundedRectSdf(position, size, radius, 5, 5)).toBeCloseTo(-5);
    // right edge midpoint: exactly on the boundary
    expect(roundedRectSdf(position, size, radius, 10, 5)).toBeCloseTo(0);
    expect(roundedRectSdf(position, size, radius, 12, 5)).toBeCloseTo(2);
    // corner region: outside the rounded arc
    expect(roundedRectSdf(position, size, radius, 0, 0)).toBeCloseTo(Math.hypot(2, 2) - 2);
    expect(roundedRectSdf(position, size, radius, 0, 0)).toBeGreaterThan(0);
  });

  it("reflects radius changes in the signed distance", () => {
    // flat-edge midpoints stay on the boundary for any radius <= half
    expect(roundedRectSdf(position, size, 1, 10, 5)).toBeCloseTo(0);
    expect(roundedRectSdf(position, size, 5, 10, 5)).toBeCloseTo(0);
    // corner distance grows with radius
    const r1 = roundedRectSdf(position, size, 1, 0, 0);
    const r5 = roundedRectSdf(position, size, 5, 0, 0);
    expect(r1).toBeGreaterThan(0);
    expect(r5).toBeGreaterThan(r1);
  });

  it("clamps radius to min(radius, half extents) like CSS rounded rects", () => {
    // radius 100 behaves exactly like radius 5 (= min(100, 5, 5))
    for (const [x, y] of [
      [5, 5],
      [10, 5],
      [0, 5],
      [9, 7],
      [2, 2],
    ]) {
      expect(roundedRectSdf(position, size, 100, x, y)).toBe(
        roundedRectSdf(position, size, 5, x, y),
      );
    }
    // radius == half makes an exact circle: d = |p - center| - half
    const circle = (x: number, y: number) => Math.hypot(x - 5, y - 5) - 5;
    for (const [x, y] of [
      [5, 5],
      [10, 5],
      [0, 5],
      [9, 7],
    ]) {
      expect(roundedRectSdf(position, size, 100, x, y)).toBeCloseTo(circle(x, y), 12);
    }
  });

  it("is finite everywhere in the scene", () => {
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        expect(Number.isFinite(roundedRectSdf(position, size, radius, x + 0.5, y + 0.5))).toBe(true);
      }
    }
  });
});

describe("roundedRectSurfaceHeight", () => {
  it("is a flat step for the flat profile", () => {
    const s = surface({ profile: { kind: "flat" }, thickness: 1 });
    expect(roundedRectSurfaceHeight(s, 5, 5)).toBe(7);
    expect(roundedRectSurfaceHeight(s, 13, 5)).toBe(-Infinity); // boundary: d == 0
    expect(roundedRectSurfaceHeight(s, 15, 15)).toBe(-Infinity);
  });

  it("rises smoothly across the inward bevel band", () => {
    const s = surface();
    const center = roundedRectSurfaceHeight(s, 5, 5); // d = -2 = -bevelWidth -> plateau
    const midBand = roundedRectSurfaceHeight(s, 12, 5); // d = -1 -> half thickness
    const boundary = roundedRectSurfaceHeight(s, 13, 5); // d = 0 -> outside footprint
    const outside = roundedRectSurfaceHeight(s, 15, 15);
    expect(center).toBeCloseTo(8);
    expect(midBand).toBeCloseTo(7);
    expect(boundary).toBe(-Infinity);
    expect(outside).toBe(-Infinity);
  });

  it("keeps a zero-thickness surface alive at H = elevation inside its coverage", () => {
    const s = surface({ elevation: 6, thickness: 0 });
    expect(roundedRectSurfaceHeight(s, 5, 5)).toBe(6);
    expect(roundedRectSurfaceHeight(s, 13, 5)).toBe(-Infinity);
    const result = composeSdfHeightField(sceneWith(s));
    expect(result.height.get(5, 5)).toBe(6);
    expect(result.objectId.get(5, 5)).toBe(0);
    expect(result.height.get(15, 15)).toBe(0);
    expect(result.objectId.get(15, 15)).toBe(NO_OWNER);
  });

  it("returns -Infinity for mask shapes", () => {
    expect(roundedRectSurfaceHeight(surface({ shape: { kind: "mask" } }), 5, 5)).toBe(-Infinity);
  });
});

describe("composeSdfHeightField", () => {
  it("composes elevation + profile into the scene height", () => {
    const result = composeSdfHeightField(sceneWith(surface()));
    const height = result.height;
    expect(height.spec.width).toBe(16);
    // deep inside the button: plateau at elevation + thickness
    expect(height.get(5, 5)).toBeCloseTo(8);
    // boundary region: pixel (12,5) center (12.5, 5.5), d = -0.5 -> 6 + 2*(1 - smoothstep(0.75))
    expect(height.get(12, 5)).toBeCloseTo(6.3125, 6);
    // far outside: base plane 0, no owner
    expect(height.get(15, 15)).toBe(0);
    expect(result.objectId.get(5, 5)).toBe(0);
  });

  it("produces only finite, non-negative heights", () => {
    const height = composeSdfHeightField(sceneWith(surface())).height;
    for (let y = 0; y < height.spec.height; y++) {
      for (let x = 0; x < height.spec.width; x++) {
        const h = height.get(x, y);
        expect(Number.isFinite(h)).toBe(true);
        expect(h).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("reflects elevation and bevelWidth changes", () => {
    const low = composeSdfHeightField(sceneWith(surface({ elevation: 3, bevelWidth: 1 }))).height;
    const high = composeSdfHeightField(sceneWith(surface({ elevation: 9, bevelWidth: 3 }))).height;
    // plateau pixel (8,8) center (8.5, 8.5): d = -4.5, outside both bevel bands
    expect(low.get(8, 8)).toBeCloseTo(5);
    expect(high.get(8, 8)).toBeCloseTo(11);
    // edge pixel: between base and plateau, and the wider bevel keeps the
    // surface lower at the same pixel (bevelWidth changes the edge slope)
    const lowEdge = low.get(12, 5);
    const highEdge = high.get(12, 5);
    expect(lowEdge).toBeGreaterThan(0);
    expect(lowEdge).toBeLessThan(low.get(8, 8));
    expect(highEdge).toBeGreaterThan(0);
    expect(highEdge).toBeLessThan(high.get(8, 8));
    expect(highEdge - 6).toBeLessThan(lowEdge);
  });

  it("shows a step-free continuous cross-section at elevation 0", () => {
    // Standalone smooth-profile PoC: elevation 0 so the bevel rises
    // continuously from the base plane (0) to the plateau (thickness).
    const height = composeSdfHeightField(
      sceneWith(surface({ elevation: 0, thickness: 2, bevelWidth: 4 })),
    ).height;
    const bytes = new Uint8Array(height.data.buffer);
    const line = sampleLine({ spec: height.spec, bytes }, 0, 8, 15, 8, 16);
    const values = line.map((s) => s.value);
    expect(values[0]).toBe(0); // base plane outside
    expect(values[15]).toBe(0);
    expect(Math.max(...values)).toBeCloseTo(2, 1); // plateau == thickness
    // Discontinuity detection: a step would jump by ~thickness (or elevation)
    // between adjacent pixels. The C1 smoothstep slope is bounded by
    // 1.5 * thickness / bevelWidth = 0.75 per pixel here.
    for (let i = 1; i < values.length; i++) {
      expect(Math.abs(values[i] - values[i - 1])).toBeLessThan(1);
    }
    // the edge is a smooth slope, not a step: several distinct intermediate heights
    const firstPositive = values.findIndex((v) => v > 0);
    const lastPositive = values.length - 1 - [...values].reverse().findIndex((v) => v > 0);
    const distinct = new Set(
      values.slice(firstPositive, lastPositive + 1).map((v) => Math.round(v * 100) / 100),
    ).size;
    expect(distinct).toBeGreaterThanOrEqual(4);
  });
});

describe("generateSdfDebug", () => {
  it("produces sdf, mask and height buffers for human inspection", () => {
    const scene = sceneWith(surface());
    const { sdf, mask, height } = generateSdfDebug(scene);
    expect(sdf.get(5, 5)).toBeLessThan(0);
    expect(sdf.get(15, 15)).toBeGreaterThan(0);
    expect(mask.get(5, 5)).toBe(1);
    expect(mask.get(15, 15)).toBe(0);
    expect(height.get(5, 5)).toBeCloseTo(8);
    expect(height.get(15, 15)).toBe(0);
  });

  it("all buffers are finite", () => {
    const { sdf, mask, height } = generateSdfDebug(sceneWith(surface()));
    for (const buf of [sdf, mask, height]) {
      const bytes = new Uint8Array((buf as HostBuffer).data.buffer);
      for (let y = 0; y < buf.spec.height; y++) {
        for (let x = 0; x < buf.spec.width; x++) {
          expect(Number.isFinite(readElement(bytes, buf.spec, x, y))).toBe(true);
        }
      }
    }
  });
});

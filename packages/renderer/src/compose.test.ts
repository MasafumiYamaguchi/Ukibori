import { describe, expect, it } from "vitest";
import { HostBuffer } from "./buffer";
import {
  NO_OWNER,
  composeHeightField,
  flatRoundedRectHeight,
  sceneMaterials,
} from "./compose";
import { createScene } from "./scene";
import type { Scene, SurfaceNode } from "./scene";

const flat: SurfaceNode["profile"] = () => 0;

function rectSurface(partial: Partial<SurfaceNode> = {}): SurfaceNode {
  return {
    id: "a",
    position: { x: 0, y: 0 },
    size: { x: 10, y: 10 },
    elevation: 5,
    thickness: 0,
    shape: { kind: "roundedRect", radius: 0 },
    profile: flat,
    material: "silicone",
    castsShadow: true,
    receivesShadow: true,
    ...partial,
  };
}

function sceneWith(...surfaces: SurfaceNode[]): Scene {
  return createScene({ width: 16, height: 16, surfaces });
}

function compose(...surfaces: SurfaceNode[]) {
  return composeHeightField(sceneWith(...surfaces), flatRoundedRectHeight);
}

describe("sceneMaterials", () => {
  it("lists unique materials in first-appearance order", () => {
    const scene = sceneWith(
      rectSurface({ id: "s1", material: "silicone" }),
      rectSurface({ id: "s2", material: "metal" }),
      rectSurface({ id: "s3", material: "silicone" }),
    );
    expect(sceneMaterials(scene)).toEqual(["silicone", "metal"]);
  });
});

describe("composeHeightField", () => {
  it("writes surface height inside the shape and 0 outside", () => {
    const result = compose(rectSurface({ id: "s", position: { x: 2, y: 2 }, elevation: 4, thickness: 2 }));
    expect(result.height.spec.width).toBe(16);
    expect(result.height.spec.height).toBe(16);
    expect(result.height.get(3, 3)).toBe(6);
    expect(result.height.get(13, 13)).toBe(0);
  });

  it("samples the height field at pixel centers (x + 0.5, y + 0.5)", () => {
    // Rect [0, 10) x [0, 10): pixel 9 center (9.5) is inside, pixel 10 center (10.5) is outside.
    const result = compose(rectSurface({ id: "s", position: { x: 0, y: 0 }, size: { x: 10, y: 10 } }));
    expect(result.height.get(9, 9)).toBe(5);
    expect(result.objectId.get(9, 9)).toBe(0);
    expect(result.height.get(10, 10)).toBe(0);
    expect(result.objectId.get(10, 10)).toBe(NO_OWNER);
  });

  it("rounds heights to f32 before comparison and storage", () => {
    const scene = sceneWith(rectSurface({ id: "s", position: { x: 0, y: 0 } }));
    const f64Result = 0.1 + 0.2; // 0.30000000000000004
    const f32 = Math.fround(f64Result);
    expect(f32).not.toBe(f64Result);
    const result = composeHeightField(scene, () => f64Result);
    expect(result.height.get(2, 2)).toBe(f32);
    expect(result.height.get(2, 2)).not.toBe(f64Result);
  });

  it("assigns ownership to the covering surface, NO_OWNER outside", () => {
    const result = compose(rectSurface({ id: "s", position: { x: 2, y: 2 } }));
    expect(result.objectId.get(3, 3)).toBe(0);
    expect(result.objectId.get(13, 13)).toBe(NO_OWNER);
    expect(result.materialId.get(3, 3)).toBe(0);
    expect(result.materialId.get(13, 13)).toBe(NO_OWNER);
  });

  it("keeps ownership for zero-elevation surfaces (coverage, not height)", () => {
    const result = compose(rectSurface({ elevation: 0, thickness: 0 }));
    expect(result.height.get(3, 3)).toBe(0);
    expect(result.objectId.get(3, 3)).toBe(0);
  });

  it("picks the maximum height across overlapping surfaces", () => {
    const result = compose(
      rectSurface({ id: "low", position: { x: 0, y: 0 }, size: { x: 10, y: 10 }, elevation: 2 }),
      rectSurface({ id: "high", position: { x: 3, y: 3 }, size: { x: 10, y: 10 }, elevation: 8 }),
    );
    const inside = result.height.get(4, 4);
    expect(inside).toBe(8);
    expect(result.objectId.get(4, 4)).toBe(1);
    const onlyLow = result.height.get(1, 1);
    expect(onlyLow).toBe(2);
    expect(result.objectId.get(1, 1)).toBe(0);
  });

  it("resolves exact ties with the later surface by default (DOM-like)", () => {
    const result = compose(
      rectSurface({ id: "first", position: { x: 0, y: 0 }, elevation: 4 }),
      rectSurface({ id: "second", position: { x: 5, y: 5 }, elevation: 4 }),
    );
    const overlap = result.objectId.get(6, 6);
    expect(overlap).toBe(1);
    expect(result.height.get(6, 6)).toBe(4);
  });

  it("tieBreak: first keeps the earlier surface on exact ties", () => {
    const scene = sceneWith(
      rectSurface({ id: "first", position: { x: 0, y: 0 }, elevation: 4 }),
      rectSurface({ id: "second", position: { x: 5, y: 5 }, elevation: 4 }),
    );
    const result = composeHeightField(scene, flatRoundedRectHeight, { tieBreak: "first" });
    expect(result.objectId.get(6, 6)).toBe(0);
  });

  it("keeps independent regions separate", () => {
    const result = compose(
      rectSurface({ id: "l", position: { x: 0, y: 0 }, size: { x: 4, y: 4 }, elevation: 1 }),
      rectSurface({ id: "r", position: { x: 10, y: 10 }, size: { x: 4, y: 4 }, elevation: 7 }),
    );
    expect(result.height.get(2, 2)).toBe(1);
    expect(result.objectId.get(2, 2)).toBe(0);
    expect(result.height.get(12, 12)).toBe(7);
    expect(result.objectId.get(12, 12)).toBe(1);
  });

  it("treats non-finite geometry as no geometry", () => {
    const scene = sceneWith(rectSurface({ id: "s", position: { x: 0, y: 0 } }));
    const result = composeHeightField(scene, () => NaN);
    expect(result.height.get(2, 2)).toBe(0);
    expect(result.objectId.get(2, 2)).toBe(NO_OWNER);
  });

  it("maps materials to indices in first-appearance order", () => {
    const result = compose(
      rectSurface({ id: "a", position: { x: 0, y: 0 }, material: "matte" }),
      rectSurface({ id: "b", position: { x: 2, y: 2 }, material: "metal" }),
    );
    expect(result.materials).toEqual(["matte", "metal"]);
    expect(result.materialId.get(1, 1)).toBe(0);
    expect(result.materialId.get(3, 3)).toBe(1);
  });
});

describe("flatRoundedRectHeight", () => {
  it("cuts corners of rounded rectangles", () => {
    const surface = rectSurface({ position: { x: 0, y: 0 }, size: { x: 10, y: 10 }, shape: { kind: "roundedRect", radius: 3 }, elevation: 5 });
    expect(flatRoundedRectHeight(surface, 5, 5)).toBe(5);
    expect(flatRoundedRectHeight(surface, 0, 0)).toBe(-Infinity);
    expect(flatRoundedRectHeight(surface, 1, 1)).toBe(5);
    expect(flatRoundedRectHeight(surface, 10, 10)).toBe(-Infinity);
  });

  it("clamps over-large radius to half extents", () => {
    const surface = rectSurface({ position: { x: 0, y: 0 }, size: { x: 4, y: 4 }, shape: { kind: "roundedRect", radius: 100 } });
    expect(flatRoundedRectHeight(surface, 2, 2)).toBe(5);
  });
});

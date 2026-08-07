import { describe, expect, it } from "vitest";
import { composeSdfHeightField, maskSurfaceHeight } from "./geometry";
import { maskFromAscii } from "./mask";
import { lightScene } from "./lighting";
import { computeVisibility } from "./shadow";
import { createScene } from "./scene";
import type { Scene, SurfaceNode } from "./scene";

/**
 * P-like glyph (6x5 mask with a bowl counter):
 *   #####
 *   #...#
 *   #...#
 *   #####
 *   #....
 *   #....
 */
const P_MASK = maskFromAscii([
  "#####",
  "#...#",
  "#...#",
  "#####",
  "#....",
  "#....",
]);

/** U-like icon mask, open at the top (open counter). */
const U_MASK = maskFromAscii(["#...#", "#...#", "#####"]);

const bevel = { kind: "bevel" } as const;

function glyphSurface(partial: Partial<SurfaceNode> = {}): SurfaceNode {
  return {
    id: "glyph",
    position: { x: 5, y: 5 },
    size: { x: 6, y: 5 },
    elevation: 6,
    thickness: 1,
    bevelWidth: 1,
    shape: { kind: "mask", mask: P_MASK },
    profile: bevel,
    material: "metal",
    castsShadow: true,
    receivesShadow: true,
    ...partial,
  };
}

function buttonScene(glyph?: SurfaceNode): Scene {
  return createScene({
    width: 16,
    height: 16,
    surfaces: [
      {
        id: "btn",
        position: { x: 3, y: 3 },
        size: { x: 10, y: 10 },
        elevation: 4,
        shape: { kind: "roundedRect", radius: 0 },
        profile: { kind: "flat" },
        material: "silicone",
        castsShadow: true,
        receivesShadow: true,
      },
      ...(glyph ? [glyph] : []),
    ],
    light: { direction: { x: 0.70710678, y: 0, z: 0.70710678 }, intensity: 1 },
  });
}

describe("maskSurfaceHeight", () => {
  it("raises the glyph strokes above the base and cuts the counter", () => {
    const s = glyphSurface({ profile: { kind: "flat" } });
    // (5.5, 5.5) -> mask pixel (0, 0): the P stem
    expect(maskSurfaceHeight(s, 5.5, 5.5)).toBe(7);
    // (7.5, 6.5) -> mask pixel (2, 1): the bowl counter (empty)
    expect(maskSurfaceHeight(s, 7.5, 6.5)).toBe(-Infinity);
    // outside the footprint
    expect(maskSurfaceHeight(s, 15, 15)).toBe(-Infinity);
  });

  it("follows the bevel profile inside strokes", () => {
    const s = glyphSurface();
    // the P's deepest ink points approach the plateau at elevation + thickness
    // (this thin mask has no wide plateau, so use a loose tolerance)
    expect(maskSurfaceHeight(s, 7.5, 5.5)).toBeCloseTo(7, 2);
    // inside the stem's bevel band (mask px = 0.75, d ~ -0.5): the relief is
    // between the elevation and the plateau
    const mid = maskSurfaceHeight(s, 5.9, 6.5);
    expect(mid).toBeGreaterThan(6);
    expect(mid).toBeLessThan(7);
  });
});

describe("glyph composition and lighting", () => {
  it("composes the glyph silhouette with holes into the scene height", () => {
    const scene = buttonScene(glyphSurface({ position: { x: 4, y: 4 }, size: { x: 6, y: 6 } }));
    const c = composeSdfHeightField(scene);
    // glyph pixels (elevation 6 + thickness 1) own the height inside strokes
    expect(c.height.get(4, 4)).toBe(7);
    expect(c.objectId.get(4, 4)).toBe(1);
    // the bowl counter pixel is owned by the button below
    expect(c.height.get(6, 6)).toBe(4);
    expect(c.objectId.get(6, 6)).toBe(0);
    // button-only area
    expect(c.height.get(3, 12)).toBe(4);
  });

  it("lets the glyph participate in normals and lighting", () => {
    const scene = buttonScene(glyphSurface());
    const lit = lightScene(scene);
    // glyph stroke interior is flat (+z normal)
    expect(lit.normal.get(5, 8, 2)).toBeCloseTo(1, 5);
    // the glyph's edge tilts the normal (lighting responds to the silhouette)
    const edgeNormal = lit.normal.get(4, 8, 2);
    expect(edgeNormal).toBeLessThan(0.99);
  });
});

describe("glyph cast shadows", () => {
  it("casts a shadow shaped by the glyph silhouette, not a bounding box", () => {
    // C-like icon open to the LEFT (the shadow side): the middle row has ink
    // only at the far arm, so rays from button pixels on that row pass
    // through the open counter -> a lit gap appears in the shadow.
    const cMask = maskFromAscii(["####.", "....#", "####."]);
    const icon = glyphSurface({
      id: "icon",
      position: { x: 5, y: 5 },
      size: { x: 5, y: 3 },
      elevation: 6,
      thickness: 1,
      bevelWidth: 1,
      shape: { kind: "mask", mask: cMask },
    });
    const scene = buttonScene(icon);
    const c = composeSdfHeightField(scene);
    const vis = computeVisibility(scene, c.height, {
      objectId: c.objectId,
      casterHeight: c.height,
    });
    // button-top pixel left of the icon at the ARM rows (mask rows 0/2):
    // blocked by the left arm -> shadowed
    expect(vis.get(4, 5, 0)).toBe(0);
    expect(vis.get(4, 7, 0)).toBe(0);
    // the SAME position at the OPEN middle row: the ray passes through the
    // open counter (the far arm is beyond the ray's reach) -> LIT gap
    expect(vis.get(4, 6, 0)).toBe(1);
    expect(vis.get(5, 6, 0)).toBe(1);
    // right of the open counter the far arm casts its own shadow
    expect(vis.get(7, 6, 0)).toBe(0);
  });

  it("glyph elevation changes the shadow geometry", () => {
    const low = buttonScene(glyphSurface({ position: { x: 4, y: 4 }, size: { x: 6, y: 6 }, elevation: 6 }));
    const high = buttonScene(glyphSurface({ position: { x: 4, y: 4 }, size: { x: 6, y: 6 }, elevation: 9 }));
    const countShadowed = (scene: Scene): number => {
      const c = composeSdfHeightField(scene);
      const vis = computeVisibility(scene, c.height, { objectId: c.objectId, casterHeight: c.height });
      let n = 0;
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          // count shadowed BUTTON pixels (not the glyph itself)
          if (vis.get(x, y, 0) === 0 && c.objectId.get(x, y, 0) === 0) {
            n++;
          }
        }
      }
      return n;
    };
    expect(countShadowed(high)).toBeGreaterThan(countShadowed(low));
  });

  it("the P counter is reflected in the glyph geometry (not a filled box)", () => {
    const scene = buttonScene(glyphSurface({ position: { x: 4, y: 4 }, size: { x: 6, y: 6 } }));
    const c = composeSdfHeightField(scene);
    // bounding-box substitute would put the glyph (z=7) over the counter
    expect(c.height.get(6, 6)).toBe(4); // the counter stays at the button top
  });
});

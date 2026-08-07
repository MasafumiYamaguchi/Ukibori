import { describe, expect, it } from "vitest";
import { composeSdfHeightField, maskSurfaceHeight } from "./geometry";
import { maskFromAscii } from "./mask";
import { lightScene } from "./lighting";
import { computeVisibility } from "./shadow";
import { createScene } from "./scene";
import type { Scene, SurfaceNode } from "./scene";

/**
 * P-like glyph (5x6 mask with a bowl counter):
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

/** C-like icon mask, open to the left (open counter). */
const C_MASK = maskFromAscii(["####.", "....#", "####."]);

const bevel = { kind: "bevel" } as const;

function glyphSurface(partial: Partial<SurfaceNode> = {}): SurfaceNode {
  return {
    id: "glyph",
    position: { x: 5, y: 5 },
    size: { x: 5, y: 6 },
    // #13 elevation semantics: glyph base z = 6, ON TOP of the button top
    // (button top = 4 + 2 = 6); thickness is the relief amount (top z = 6.8)
    elevation: 6,
    thickness: 0.8,
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
        thickness: 2, // button top z = 6
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
  it("raises the glyph strokes above the button top and cuts the counter", () => {
    const s = glyphSurface({ profile: { kind: "flat" } });
    // (5.5, 5.5) -> mask pixel (0, 0): the P stem, relief top z = 6 + 0.8
    expect(maskSurfaceHeight(s, 5.5, 5.5)).toBe(6.8);
    // (7.5, 6.5) -> mask pixel (2, 1): the bowl counter (empty)
    expect(maskSurfaceHeight(s, 7.5, 6.5)).toBe(-Infinity);
    // outside the footprint
    expect(maskSurfaceHeight(s, 15, 15)).toBe(-Infinity);
  });

  it("follows the bevel profile inside strokes", () => {
    const s = glyphSurface();
    // every ink pixel of this thin mask is within 0.5 of a boundary
    // (including the raster edge via the virtual padding), so the maximum
    // relief depth is 0.5 -> height 6.4
    expect(maskSurfaceHeight(s, 5.5, 8)).toBeCloseTo(6.4, 4);
    // the raster edge itself samples d = 0 -> no coverage
    expect(maskSurfaceHeight(s, 5, 8)).toBe(-Infinity);
    // inside the stem's bevel band (mask px = 0.75, d ~ -0.5): the relief is
    // between the base and the deepest point
    const mid = maskSurfaceHeight(s, 5.9, 6.5);
    expect(mid).toBeGreaterThan(6);
    expect(mid).toBeLessThan(6.4);
  });
});

describe("glyph composition and lighting", () => {
  it("composes the glyph silhouette with holes into the scene height", () => {
    const scene = buttonScene(glyphSurface({ position: { x: 4, y: 4 } }));
    const c = composeSdfHeightField(scene);
    // glyph pixels (base 6 + relief) own the height inside strokes
    expect(c.height.get(4, 7)).toBeGreaterThan(6.3);
    expect(c.objectId.get(4, 7)).toBe(1);
    // the bowl counter pixel is owned by the button below
    expect(c.height.get(6, 6)).toBe(6);
    expect(c.objectId.get(6, 6)).toBe(0);
    // button-only area
    expect(c.height.get(3, 12)).toBe(6);
  });

  it("lets the glyph participate in normals and lighting", () => {
    const scene = buttonScene(glyphSurface());
    const lit = lightScene(scene);
    // a flat glyph interior pixel is +z
    expect(lit.normal.get(5, 7, 2)).toBeCloseTo(1, 3);
    // the glyph's counter/edge tilts the normal (lighting responds to the
    // silhouette)
    expect(lit.normal.get(5, 8, 2)).toBeLessThan(0.99);
  });
});

describe("glyph cast shadows", () => {
  it("casts a shadow shaped by the glyph silhouette, not a bounding box", () => {
    // C-like icon open to the LEFT (the shadow side): the middle row has ink
    // only at the far arm, so rays from button pixels on that row pass
    // through the open counter -> a lit gap appears in the shadow. Thin
    // reliefs need a small self-shadow bias to stay visible.
    const icon = glyphSurface({
      id: "icon",
      position: { x: 5, y: 6 },
      size: { x: 5, y: 3 },
      elevation: 6,
      thickness: 1.5,
      bevelWidth: 0.4,
      shape: { kind: "mask", mask: C_MASK },
    });
    const scene = buttonScene(icon);
    const c = composeSdfHeightField(scene);
    const vis = computeVisibility(scene, c.height, {
      objectId: c.objectId,
      casterHeight: c.height,
      bias: 0.2,
    });
    // button-top pixel left of the icon at the ARM rows (mask rows 0/2):
    // blocked by the left arm -> shadowed
    expect(vis.get(4, 6, 0)).toBe(0);
    expect(vis.get(4, 8, 0)).toBe(0);
    // the SAME position at the OPEN middle row: the ray passes through the
    // open counter (the far arm is beyond the ray's reach) -> LIT gap
    expect(vis.get(4, 7, 0)).toBe(1);
    expect(vis.get(5, 7, 0)).toBe(1);
    // right of the open counter the far arm casts its own shadow
    expect(vis.get(8, 7, 0)).toBe(0);
  });

  it("glyph elevation changes the shadow geometry", () => {
    const low = buttonScene(glyphSurface({ position: { x: 4, y: 4 } }));
    const high = buttonScene(glyphSurface({ position: { x: 4, y: 4 }, elevation: 9 }));
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

  it("changing the light direction moves the glyph shadow", () => {
    // the C icon on the button; only the light direction changes
    const icon = glyphSurface({
      id: "icon",
      position: { x: 5, y: 6 },
      size: { x: 5, y: 3 },
      elevation: 6,
      thickness: 1.5,
      bevelWidth: 0.4,
      shape: { kind: "mask", mask: C_MASK },
    });
    const sceneAt = (lx: number): Scene =>
      createScene({
        width: 16,
        height: 16,
        surfaces: [
          {
            id: "btn",
            position: { x: 3, y: 3 },
            size: { x: 10, y: 10 },
            elevation: 4,
            thickness: 2,
            shape: { kind: "roundedRect", radius: 0 },
            profile: { kind: "flat" },
            material: "silicone",
            castsShadow: true,
            receivesShadow: true,
          },
          icon,
        ],
        light: { direction: { x: lx, y: 0, z: 0.70710678 }, intensity: 1 },
      });
    const shadowVis = (scene: Scene) => {
      const c = composeSdfHeightField(scene);
      return computeVisibility(scene, c.height, {
        objectId: c.objectId,
        casterHeight: c.height,
        bias: 0.2,
      });
    };
    const fromRight = shadowVis(sceneAt(0.70710678));
    const fromLeft = shadowVis(sceneAt(-0.70710678));
    // with the light on the right the pixel left of the icon (at the arm row)
    // is in the shadow and the pixel right of it is lit; with the light on
    // the left the shadow appears on the other side
    expect(fromRight.get(4, 6, 0)).toBe(0);
    expect(fromRight.get(9, 6, 0)).toBe(1);
    expect(fromLeft.get(4, 6, 0)).toBe(1);
    expect(fromLeft.get(9, 6, 0)).toBe(0);
  });

  it("the P counter is reflected in the glyph geometry (not a filled box)", () => {
    const scene = buttonScene(glyphSurface({ position: { x: 4, y: 4 } }));
    const c = composeSdfHeightField(scene);
    // bounding-box substitute would put the glyph relief over the counter
    expect(c.height.get(6, 6)).toBe(6); // the counter stays at the button top
  });
});

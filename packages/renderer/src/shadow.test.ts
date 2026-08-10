import { describe, expect, it } from "vitest";
import { HostBuffer, readElement } from "./buffer";
import { composeCasterHeightField, composeSdfHeightField } from "./geometry";
import {
  computeVisibility,
  isOccludedWithContext,
  marchShadowRay,
  prepareShadowContext,
  sampleHeightAt,
  traceShadowRay,
} from "./shadow";
import { createScene } from "./scene";
import type { Scene, SurfaceNode } from "./scene";

/**
 * Synthetic two-level height field (the #17 verification fixture):
 * a raised slab at z = 6 over pixels x 8..13, y 2..3 (centers 8.5..13.5,
 * 2.5..3.5); everywhere else z = 0 (the receiver plane).
 */
function twoLevelHeight(): HostBuffer {
  const buf = new HostBuffer({ width: 16, height: 16, channels: 1, format: "f32" });
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      buf.set(x, y, 0, x >= 8 && x <= 13 && y >= 2 && y <= 3 ? 6 : 0);
    }
  }
  return buf;
}

function sceneWithLight(direction: { x: number; y: number; z: number }): Scene {
  return createScene({ width: 16, height: 16, light: { direction, intensity: 1 } });
}

const LIGHT_FROM_RIGHT = { x: 0.70710678, y: 0, z: 0.70710678 }; // 45 degrees, +x
const LIGHT_FROM_LEFT = { x: -0.70710678, y: 0, z: 0.70710678 };

function rowVisibility(vis: HostBuffer, y: number): number[] {
  const out: number[] = [];
  for (let x = 0; x < vis.spec.width; x++) {
    out.push(vis.get(x, y, 0));
  }
  return out;
}

describe("sampleHeightAt", () => {
  it("bilinearly interpolates between pixel centers", () => {
    const buf = new HostBuffer({ width: 2, height: 1, channels: 1, format: "f32" });
    buf.set(0, 0, 0, 0);
    buf.set(1, 0, 0, 10);
    expect(sampleHeightAt(buf, 0.5, 0.5)).toBe(0);
    expect(sampleHeightAt(buf, 1.5, 0.5)).toBe(10);
    expect(sampleHeightAt(buf, 1.0, 0.5)).toBe(5);
  });

  it("clamps outside the buffer (replicate edge)", () => {
    const buf = new HostBuffer({ width: 2, height: 1, channels: 1, format: "f32" });
    buf.set(0, 0, 0, 3);
    buf.set(1, 0, 0, 7);
    expect(sampleHeightAt(buf, -5, 0.5)).toBe(3);
    expect(sampleHeightAt(buf, 50, 0.5)).toBe(7);
  });
});

describe("computeVisibility on the two-level fixture", () => {
  it("prepares pass-wide context: maxDistance scales with 1/|L.xy|", () => {
    const ctx = prepareShadowContext(sceneWithLight({ x: 0.5, y: 0, z: 0.8660254 }), twoLevelHeight());
    expect(ctx.maxDistance).toBe(Math.fround(Math.hypot(16, 16) / 0.5));
    expect(ctx.bias).toBe(0.5);
    expect(ctx.stepSize).toBe(0.5);
    expect(ctx.maxHeight).toBe(6);
    // near-vertical light: no horizontal travel, diagonal is a harmless cap
    const vertical = prepareShadowContext(sceneWithLight({ x: 0, y: 0, z: 1 }), twoLevelHeight());
    expect(vertical.maxDistance).toBe(Math.fround(Math.hypot(16, 16)));
  });

  it("canonicalizes the sanitized bias to f32 in the prepared context", () => {
    const ctx = prepareShadowContext(sceneWithLight(LIGHT_FROM_RIGHT), twoLevelHeight(), {
      bias: 0.1,
    });
    expect(ctx.bias).toBe(Math.fround(0.1));
    expect(ctx.bias).not.toBe(0.1); // f64 differs; the f32 value matches a WGSL uniform
  });

  it("applies the GPU-equivalent termination cap to custom march options", () => {
    const scene = sceneWithLight(LIGHT_FROM_RIGHT);
    const height = twoLevelHeight();
    const tinyStep = prepareShadowContext(scene, height, {
      stepSize: 1e-40,
      maxDistance: 8,
    });
    expect(tinyStep.stepSize).toBe(0.5);
    expect(tinyStep.maxDistance).toBe(8);

    const hugeDistance = prepareShadowContext(scene, height, {
      maxDistance: 1e30,
    });
    expect(hugeDistance.stepSize).toBe(0.5);
    expect(hugeDistance.maxDistance).toBe(
      Math.fround(Math.hypot(16, 16) / Math.hypot(LIGHT_FROM_RIGHT.x, LIGHT_FROM_RIGHT.y)),
    );
  });

  it("reaches occluders that require t > the scene diagonal (default maxDistance = diagonal / |L.xy|)", () => {
    // tall occluder 13 units from the receiver (0.5, 8.5); |L.xy| = 0.5 so
    // t ≈ 26 at the occluder, beyond the scene diagonal (~22.6)
    const height = new HostBuffer({ width: 16, height: 16, channels: 1, format: "f32" });
    height.set(13, 8, 0, 24);
    const scene = sceneWithLight({ x: 0.5, y: 0, z: 0.8660254 });
    const vis = computeVisibility(scene, height);
    expect(vis.get(0, 8, 0)).toBe(0); // occluded: the ray travels the full distance
    expect(vis.get(15, 8, 0)).toBe(1); // light side: ray moves away from the occluder
    // with an explicit cap below the required t, the occluder is never reached
    const capped = computeVisibility(scene, height, { maxDistance: 20 });
    expect(capped.get(0, 8, 0)).toBe(1);
  });

  it("uses f32(rayZ + bias) thresholds consistent with the f32 height samples", () => {
    // Precondition: 0.3 and 0.1 + 0.2 differ in f64 but round to the same f32.
    expect(0.3).not.toBe(0.1 + 0.2);
    expect(Math.fround(0.3)).toBe(Math.fround(0.1 + 0.2));
    // height pixel (1, 0) stores f32(0.1 + 0.2); light travels +x at z = 0 so
    // rayZ stays 0 and the threshold is f32(0 + 0.3) — the sample is exactly
    // ON the f32 threshold (not above it), so the pixel is NOT occluded.
    // A naive f64 comparison (0.30000001192092896 > 0.3) would say occluded.
    const height = new HostBuffer({ width: 16, height: 16, channels: 1, format: "f32" });
    height.set(1, 0, 0, 0.1 + 0.2);
    const scene = sceneWithLight({ x: 1, y: 0, z: 0 });
    const ray = traceShadowRay(scene, height, 0.5, 0.5, { bias: 0.3, stepSize: 0.5 });
    expect(ray.occluded).toBe(false);
  });

  it("marchShadowRay exposes the blocking sample for ray visualization", () => {
    const samples = marchShadowRay(
      sceneWithLight(LIGHT_FROM_RIGHT),
      twoLevelHeight(),
      5.5,
      3.5,
    );
    expect(samples.length).toBeGreaterThan(0);
    const blocking = samples.find((s) => s.occluded);
    expect(blocking).toBeDefined();
    expect(blocking!.height).toBeGreaterThan(blocking!.rayZ + 0.5 - 1e-6);
    // samples before the block are not occluded
    for (const s of samples) {
      if (s !== blocking) {
        expect(s.occluded).toBe(false);
      }
    }
  });

  it("parity: summary tracing and marchShadowRay agree on occlusion for every fixture ray", () => {
    const scene = sceneWithLight(LIGHT_FROM_RIGHT);
    const height = twoLevelHeight();
    let blocked = 0;
    let lit = 0;
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const summary = traceShadowRay(scene, height, x + 0.5, y + 0.5);
        const samples = marchShadowRay(scene, height, x + 0.5, y + 0.5);
        expect(summary.occluded).toBe(samples.some((s) => s.occluded));
        if (summary.occluded) {
          blocked++;
        } else {
          lit++;
        }
      }
    }
    expect(blocked).toBeGreaterThan(0); // the fixture has both blocked and lit rays
    expect(lit).toBeGreaterThan(0);
  });

  it("parity: isOccludedWithContext matches the visibility mask per pixel", () => {
    const scene = sceneWithLight(LIGHT_FROM_RIGHT);
    const height = twoLevelHeight();
    const ctx = prepareShadowContext(scene, height);
    const vis = computeVisibility(scene, height);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const occluded = isOccludedWithContext(ctx, height, x + 0.5, y + 0.5);
        expect(vis.get(x, y, 0)).toBe(occluded ? 0 : 1);
      }
    }
  });

  it("occludes pixels between the caster and the light", () => {
    const vis = computeVisibility(sceneWithLight(LIGHT_FROM_RIGHT), twoLevelHeight());
    const row = rowVisibility(vis, 3); // through the caster's row
    // light from +x: the shadow falls to the LEFT of the caster
    expect(row[5]).toBe(0); // under/near the shadow
    expect(row[7]).toBe(0); // just left of the caster
    expect(row[0]).toBe(1); // far left, ray clears the caster
    expect(row[2]).toBe(1);
    expect(row[8]).toBe(1); // caster top (lit)
    expect(row[12]).toBe(1); // caster top far side
    expect(row[15]).toBe(1); // light side of the caster
  });

  it("flips the shadow to the other side when the light flips", () => {
    const right = computeVisibility(sceneWithLight(LIGHT_FROM_RIGHT), twoLevelHeight());
    const left = computeVisibility(sceneWithLight(LIGHT_FROM_LEFT), twoLevelHeight());
    const rowRight = rowVisibility(right, 3);
    const rowLeft = rowVisibility(left, 3);
    expect(rowRight[5]).toBe(0);
    expect(rowLeft[5]).toBe(1);
    expect(rowLeft[14]).toBe(0); // shadow on the right side now
    expect(rowLeft[0]).toBe(1);
  });

  it("restores full visibility when the occluder is removed", () => {
    const flat = new HostBuffer({ width: 16, height: 16, channels: 1, format: "f32" });
    const vis = computeVisibility(sceneWithLight(LIGHT_FROM_RIGHT), flat);
    expect(rowVisibility(vis, 3).every((v) => v === 1)).toBe(true);
  });

  it("produces a binary mask with finite values everywhere", () => {
    const vis = computeVisibility(sceneWithLight(LIGHT_FROM_RIGHT), twoLevelHeight());
    const bytes = new Uint8Array(vis.data.buffer);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const v = readElement(bytes, vis.spec, x, y);
        expect(v === 0 || v === 1).toBe(true);
      }
    }
  });

  it("lengthens the shadow with lower light elevation", () => {
    const steep = sceneWithLight({ x: 0.5, y: 0, z: 0.8660254 }); // 60 degrees
    const shallow = sceneWithLight({ x: 0.8660254, y: 0, z: 0.5 }); // 30 degrees
    const count = (vis: HostBuffer): number =>
      rowVisibility(vis, 3).filter((v) => v === 0).length;
    expect(count(computeVisibility(shallow, twoLevelHeight()))).toBeGreaterThan(
      count(computeVisibility(steep, twoLevelHeight())),
    );
  });

  it("extends the shadow when the caster elevation rises", () => {
    const tall = new HostBuffer({ width: 16, height: 16, channels: 1, format: "f32" });
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        tall.set(x, y, 0, x >= 8 && x <= 13 && y >= 2 && y <= 3 ? 12 : 0);
      }
    }
    const count = (vis: HostBuffer): number =>
      rowVisibility(vis, 3).filter((v) => v === 0).length;
    expect(count(computeVisibility(sceneWithLight(LIGHT_FROM_RIGHT), tall))).toBeGreaterThan(
      count(computeVisibility(sceneWithLight(LIGHT_FROM_RIGHT), twoLevelHeight())),
    );
  });

  it("bias suppresses self-shadowing on slopes", () => {
    // ramp H(x) = 0.55 * x; ray ascends ~0.5 per unit -> the ray is
    // marginally below the surface and self-occludes without a bias
    const ramp = new HostBuffer({ width: 16, height: 16, channels: 1, format: "f32" });
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        ramp.set(x, y, 0, 0.55 * x);
      }
    }
    const scene = sceneWithLight({ x: 0.89442719, y: 0, z: 0.4472136 }); // ascent 0.5/unit
    const noBias = computeVisibility(scene, ramp, { bias: 0 });
    const biased = computeVisibility(scene, ramp, { bias: 2 });
    expect(noBias.get(10, 8, 0)).toBe(0); // self-shadowed
    expect(biased.get(10, 8, 0)).toBe(1); // suppressed by the bias
  });

  it("is deterministic", () => {
    const a = computeVisibility(sceneWithLight(LIGHT_FROM_RIGHT), twoLevelHeight());
    const b = computeVisibility(sceneWithLight(LIGHT_FROM_RIGHT), twoLevelHeight());
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
  });
});

describe("castsShadow / receivesShadow (#18 multi-surface)", () => {
  function flatSurface(partial: Partial<SurfaceNode> = {}): SurfaceNode {
    return {
      id: "s",
      position: { x: 0, y: 0 },
      size: { x: 10, y: 10 },
      elevation: 0,
      shape: { kind: "roundedRect", radius: 0 },
      profile: { kind: "flat" },
      material: "silicone",
      castsShadow: true,
      receivesShadow: true,
      ...partial,
    };
  }

  function flatScene(...surfaces: SurfaceNode[]): Scene {
    return createScene({
      width: 16,
      height: 16,
      surfaces,
      light: { direction: LIGHT_FROM_RIGHT, intensity: 1 },
    });
  }

  function composed(scene: Scene) {
    return composeSdfHeightField(scene);
  }

  it("castsShadow = false removes the surface as an occluder", () => {
    const caster = flatSurface({
      id: "btn",
      position: { x: 3, y: 3 },
      size: { x: 10, y: 10 },
      elevation: 4,
    });
    const casting = flatScene(caster);
    const ghost = flatScene({ ...caster, castsShadow: false });
    const visCast = computeVisibility(casting, composed(casting).height, {
      objectId: composed(casting).objectId,
      casterHeight: composeCasterHeightField(casting),
    });
    const visGhost = computeVisibility(ghost, composed(ghost).height, {
      objectId: composed(ghost).objectId,
      casterHeight: composeCasterHeightField(ghost),
    });
    expect(visCast.get(1, 5, 0)).toBe(0); // shadow on the base plane left of the button
    expect(visGhost.get(1, 5, 0)).toBe(1); // nothing casts
  });

  it("a non-casting top surface does not hide a lower casting surface", () => {
    // The non-casting top (4.5) FULLY covers the lower casting surface (4)
    // with the same footprint, so every sample along the tested ray inside
    // the overlap is owned by the top. Under the old owner-skip
    // implementation the ray passes through (the owner is non-casting
    // everywhere in the overlap) and the pixel stays LIT; with the caster-
    // only height field the lower caster still occludes. The top's own ramp
    // is low enough (elevation 4.5) that it does not occlude the approach.
    const caster = flatSurface({
      id: "caster",
      position: { x: 3, y: 3 },
      size: { x: 10, y: 10 },
      elevation: 4,
    });
    const top = flatSurface({
      id: "top",
      position: { x: 3, y: 3 },
      size: { x: 10, y: 10 },
      elevation: 4.5,
      castsShadow: false,
    });
    const scene = flatScene(caster, top);
    const full = composed(scene);
    const casterField = composeCasterHeightField(scene);
    expect(full.height.get(5, 5)).toBe(4.5); // the top surface owns the visible height
    expect(full.objectId.get(5, 5)).toBe(1); // ... over the whole caster area
    expect(casterField.get(5, 5)).toBe(4); // the lower caster stays in the caster field
    const vis = computeVisibility(scene, full.height, {
      objectId: full.objectId,
      casterHeight: casterField,
    });
    expect(vis.get(1, 5, 0)).toBe(0); // the lower caster occludes, even under the top
    // the decisive sample lands INSIDE the overlap: t = 2.5 at x ~ 3.27
    // (the caster's first texel, fully covered by the top)
    const ray = traceShadowRay(scene, full.height, 1.5, 5.5, {
      casterHeight: casterField,
      maxDistance: 2.5,
    });
    expect(ray.occluded).toBe(true);
    expect(ray.t).toBeCloseTo(2.5, 6);
    expect(ray.sampleX).toBeGreaterThan(3);
    expect(ray.sampleX).toBeLessThan(13);
    // the blocking height is the CASTER's field (on its left-edge bilinear
    // ramp here), not the top surface's height of 4.5
    expect(ray.blockingHeight).toBeGreaterThan(2.5);
    expect(ray.blockingHeight).toBeLessThan(4.5);
    // with only the non-casting top, rays pass through
    const onlyTop = flatScene(top);
    const fullOnly = composed(onlyTop);
    const visOnly = computeVisibility(onlyTop, fullOnly.height, {
      objectId: fullOnly.objectId,
      casterHeight: composeCasterHeightField(onlyTop),
    });
    expect(visOnly.get(1, 5, 0)).toBe(1);
  });

  it("caster-field occlusion follows bilinear height semantics at casting/non-casting boundaries", () => {
    // caster texels 3..7 (z=4); adjacent non-casting surface texels 8..11
    // (z=0), excluded from the caster field
    const caster = flatSurface({
      id: "caster",
      position: { x: 3, y: 3 },
      size: { x: 5, y: 10 },
      elevation: 4,
    });
    const adjacent = flatSurface({
      id: "adj",
      position: { x: 8, y: 3 },
      size: { x: 4, y: 10 },
      elevation: 0,
      castsShadow: false,
    });
    const scene = createScene({
      width: 16,
      height: 16,
      surfaces: [caster, adjacent],
      light: { direction: { x: -0.9, y: 0, z: 0.1 }, intensity: 1 }, // very shallow, from the left
    });
    const full = composed(scene);
    const casterField = composeCasterHeightField(scene);
    expect(casterField.get(7, 5)).toBe(4); // casting texel
    expect(casterField.get(8, 5)).toBe(0); // non-casting texel excluded
    expect(full.height.get(9, 5)).toBe(0); // receiver sits on the adjacent surface
    // the boundary between the casting texel 7 (center 7.5, height 4) and the
    // non-casting texel 8 (center 8.5, height 0) interpolates bilinearly
    expect(sampleHeightAt(casterField, 8.0, 5.5)).toBe(2); // (4 + 0) / 2
    // A shallow ray from the adjacent receiver (9.5, 5.5) is decided by the
    // sample at t = 1.5 (x ~ 8.0, between the texel centers): the bilinear
    // caster height (~1.96) exceeds the f32 threshold and occludes. A
    // nearest-owner classification would snap to the non-casting texel 8
    // (height 0) and report lit. The march is bounded so this boundary
    // sample is the decisive one.
    const ray = traceShadowRay(scene, full.height, 9.5, 5.5, {
      casterHeight: casterField,
      maxDistance: 1.5,
    });
    expect(ray.occluded).toBe(true);
    expect(ray.t).toBeCloseTo(1.5, 6);
    expect(ray.sampleX).toBeGreaterThan(8.0);
    expect(ray.sampleX).toBeLessThan(8.5);
    expect(ray.blockingHeight).toBeGreaterThan(1.5); // on the ramp, not the texel top
    expect(ray.blockingHeight).toBeLessThan(4);
  });

  it("receivesShadow = false keeps the surface lit inside the shadow", () => {
    const panel = flatSurface({ id: "panel", size: { x: 16, y: 16 } });
    const button = flatSurface({
      id: "btn",
      position: { x: 3, y: 3 },
      size: { x: 10, y: 10 },
      elevation: 4,
    });
    const receiving = flatScene(panel, button);
    const shielded = flatScene({ ...panel, receivesShadow: false }, button);
    const visRecv = computeVisibility(receiving, composed(receiving).height, {
      objectId: composed(receiving).objectId,
    });
    const visShielded = computeVisibility(shielded, composed(shielded).height, {
      objectId: composed(shielded).objectId,
    });
    expect(visRecv.get(1, 5, 0)).toBe(0); // panel pixel in the button's shadow
    expect(visShielded.get(1, 5, 0)).toBe(1); // panel ignores cast shadows
  });

  it("a badge on a button casts its shadow onto the button top", () => {
    const panel = flatSurface({ id: "panel", size: { x: 16, y: 16 } });
    const button = flatSurface({
      id: "btn",
      position: { x: 3, y: 3 },
      size: { x: 10, y: 10 },
      elevation: 4,
    });
    const badge = flatSurface({
      id: "badge",
      position: { x: 6, y: 6 },
      size: { x: 4, y: 4 },
      elevation: 6,
    });
    const scene = flatScene(panel, button, badge);
    const composedScene = composed(scene);
    expect(composedScene.height.get(7, 7)).toBe(6); // badge on top
    expect(composedScene.height.get(4, 7)).toBe(4); // button around it
    expect(composedScene.height.get(1, 1)).toBe(0); // panel outside
    const vis = computeVisibility(scene, composedScene.height, {
      objectId: composedScene.objectId,
    });
    expect(vis.get(5, 7, 0)).toBe(0); // button top in the badge's shadow
    expect(vis.get(4, 7, 0)).toBe(1); // button top clear of the badge
    expect(vis.get(7, 7, 0)).toBe(1); // badge top is lit
  });
});

describe("traceShadowRay", () => {
  it("reports the blocking sample for an occluded ray", () => {
    const ray = traceShadowRay(sceneWithLight(LIGHT_FROM_RIGHT), twoLevelHeight(), 5.5, 3.5);
    expect(ray.occluded).toBe(true);
    expect(ray.blockingHeight).toBeGreaterThan(ray.rayZ + 0.5 - 1e-6);
    expect(ray.sampleX).toBeGreaterThan(5.5); // the occluder is toward the light
  });

  it("reports no occlusion for a lit ray", () => {
    const ray = traceShadowRay(sceneWithLight(LIGHT_FROM_RIGHT), twoLevelHeight(), 0.5, 3.5);
    expect(ray.occluded).toBe(false);
  });

  it("is finite for every pixel of the fixture", () => {
    const scene = sceneWithLight(LIGHT_FROM_RIGHT);
    const height = twoLevelHeight();
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const ray = traceShadowRay(scene, height, x + 0.5, y + 0.5);
        expect(Number.isFinite(ray.rayZ)).toBe(true);
        expect(Number.isFinite(ray.blockingHeight)).toBe(true);
        expect(Number.isFinite(ray.t)).toBe(true);
      }
    }
  });
});

describe("DPR-aware render extent sampling (#27)", () => {
  it("defaults to dpr 1 and preserves the historical result byte-for-byte", () => {
    const scene = sceneWithLight(LIGHT_FROM_RIGHT);
    const height = twoLevelHeight();
    const vis = computeVisibility(scene, height);
    const visDpr1 = computeVisibility(scene, height, { dpr: 1 });
    expect(Array.from(visDpr1.data)).toEqual(Array.from(vis.data));
    const ctx = prepareShadowContext(scene, height);
    expect(ctx.dpr).toBe(1);
    // an invalid dpr falls back to 1 (stable default)
    expect(prepareShadowContext(scene, height, { dpr: NaN }).dpr).toBe(1);
    expect(prepareShadowContext(scene, height, { dpr: -2 }).dpr).toBe(1);
  });

  it("keeps the default maxDistance in scene units for any dpr", () => {
    // render 32x32 at dpr 2 covers the same logical 16x16 scene, so the
    // scene-diagonal default stays identical
    const scene = sceneWithLight({ x: 0.5, y: 0, z: 0.8660254 });
    const dpr1 = prepareShadowContext(
      scene,
      new HostBuffer({ width: 16, height: 16, channels: 1, format: "f32" }),
    );
    const dpr2 = prepareShadowContext(
      scene,
      new HostBuffer({ width: 32, height: 32, channels: 1, format: "f32" }),
      { dpr: 2 },
    );
    expect(dpr2.maxDistance).toBeCloseTo(dpr1.maxDistance, 9);
    expect(dpr2.dpr).toBe(2);
  });

  it("samples texels at ((tx + 0.5) / dpr, (ty + 0.5) / dpr) and matches direct traces", () => {
    // 2x scaled copy of the two-level slab: render 32x32, slab texels
    // 16..27 x 4..7 (logical 8..13.5 x 2..3.5)
    const scene = sceneWithLight(LIGHT_FROM_RIGHT);
    const height = new HostBuffer({ width: 32, height: 32, channels: 1, format: "f32" });
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        height.set(x, y, 0, x >= 16 && x <= 27 && y >= 4 && y <= 7 ? 6 : 0);
      }
    }
    const vis = computeVisibility(scene, height, { dpr: 2 });
    // the receiver position of render texel (x, y) is ((x + 0.5) / 2, ...);
    // every decision must equal a direct trace at that logical position
    let blocked = 0;
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        const ray = traceShadowRay(scene, height, (x + 0.5) / 2, (y + 0.5) / 2, { dpr: 2 });
        expect(vis.get(x, y, 0)).toBe(ray.occluded ? 0 : 1);
        if (ray.occluded) {
          blocked++;
        }
      }
    }
    expect(blocked).toBeGreaterThan(0);
  });

  it("doubles the shadow texel span when the render extent doubles at dpr 2", () => {
    const scene = sceneWithLight(LIGHT_FROM_RIGHT);
    const dpr1 = computeVisibility(scene, twoLevelHeight());
    const scaled = new HostBuffer({ width: 32, height: 32, channels: 1, format: "f32" });
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        scaled.set(x, y, 0, x >= 16 && x <= 27 && y >= 4 && y <= 7 ? 6 : 0);
      }
    }
    const dpr2 = computeVisibility(scene, scaled, { dpr: 2 });
    const count1 = rowVisibility(dpr1, 3).filter((v) => v === 0).length;
    const count2 = rowVisibility(dpr2, 6).filter((v) => v === 0).length;
    expect(count2).toBeGreaterThanOrEqual(count1 * 2 - 2);
    expect(count2).toBeLessThanOrEqual(count1 * 2 + 2);
  });

  it("stops the march at the LAST texel center (extent - 0.5) / dpr at dpr > 1", () => {
    // render 16x16 at dpr 2 covers logical [0, 8): the inclusive pixel-center
    // rectangle ends at the last texel center (16 - 0.5) / 2 = 7.75. A tall
    // caster occupies the last render column. A receiver on that caster with
    // a light leaving the field on the right must get ZERO marched samples:
    // the first sample already leaves the rectangle (a buggy
    // `extent - 0.5 / dpr` bound of 15.75 would let the ray march on over
    // the clamped caster top instead of stopping).
    const height = new HostBuffer({ width: 16, height: 16, channels: 1, format: "f32" });
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        height.set(x, y, 0, x >= 15 && y >= 6 && y <= 9 ? 4 : 0);
      }
    }
    const scene = sceneWithLight(LIGHT_FROM_RIGHT);
    // texel 15 center = 7.75; the +x ray's first sample is beyond it
    const samples = marchShadowRay(scene, height, 7.75, 4.25, { dpr: 2 });
    expect(samples.length).toBe(0);
    const vis = computeVisibility(scene, height, { dpr: 2 });
    expect(vis.get(15, 8, 0)).toBe(1); // lit: the march stopped at the bound
    // the same behavior holds at dpr 1 (last center 15.5)
    const samplesDpr1 = marchShadowRay(scene, height, 15.5, 4.25);
    expect(samplesDpr1.length).toBe(0);
    expect(computeVisibility(scene, height).get(15, 8, 0)).toBe(1);
    // and a receiver ONE texel inside still marches normally (the bound is
    // inclusive, not one texel short)
    const inner = marchShadowRay(scene, height, 7.25, 4.25, { dpr: 2 });
    expect(inner.length).toBeGreaterThan(0);
  });
});

describe("explicit f32-multiple march series (#27)", () => {
  it("marches t = fround(k * stepSize) exactly for a non-dyadic step", () => {
    // stepSize 0.1 is NOT f32-exact: the CPU series must be the f32-rounded
    // integer multiples fround(k * f32(0.1)) — the exact series the GPU
    // shader produces with `f32(stepIndex) * stepSize`. A naive f64
    // accumulation (t += stepSize, exact k * step) drifts by ~1 ulp per step
    // and is NOT the reference series.
    const scene = sceneWithLight(LIGHT_FROM_RIGHT);
    const height = twoLevelHeight();
    const samples = marchShadowRay(scene, height, 0.5, 3.5, {
      stepSize: 0.1,
      maxDistance: 1.05,
    });
    const step = Math.fround(0.1);
    const expected = [];
    for (let k = 1; k <= 10; k++) {
      expected.push(Math.fround(k * step));
    }
    expect(samples.map((s) => s.t)).toEqual(expected);
    // the count is floor(maxDistance / stepSize), matching the shadow pass
    // stepCount (10 steps for maxDistance 1.05 / step 0.1)
    expect(samples.length).toBe(10);
    // the series differs from naive f64 accumulation (regression detection):
    // t = 0.30000000447034836 (f64 exact) vs fround -> 0.30000001192092896
    expect(Math.fround(3 * step)).not.toBe(3 * step);
    expect(samples[2].t).toBe(Math.fround(3 * step));
  });

  it("distinguishes the f32 threshold judgment from a naive f64 comparison", () => {
    // caster top stores f32(0.1 + 0.2) = 0.30000001192092896; with a
    // horizontal light rayZ stays 0 and bias 0.3 gives the f32 threshold
    // f32(0 + 0.3) == the sample EXACTLY -> equality -> LIT. A naive f64
    // comparison (0.30000001192092896 > 0.3) would report BLOCKED.
    const height = new HostBuffer({ width: 16, height: 16, channels: 1, format: "f32" });
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        height.set(x, y, 0, x >= 3 && x <= 6 && y >= 6 && y <= 7 ? 0.1 + 0.2 : 0);
      }
    }
    const scene = sceneWithLight({ x: 1, y: 0, z: 0 });
    const vis = computeVisibility(scene, height, { bias: 0.3 });
    expect(vis.get(0, 6, 0)).toBe(1); // the ray crosses the caster top: equality -> lit
    expect(vis.get(2, 6, 0)).toBe(1); // ramp samples (0 / 0.15) stay below the threshold
    expect(vis.get(3, 6, 0)).toBe(1); // on the caster: rz0 = sample, ray rises -> lit
    const sample = sampleHeightAt(height, 3.5, 6.5); // the f32 top value
    expect(sample).toBe(Math.fround(0.3));
    expect(sample).toBe(Math.fround(0.1 + 0.2));
    expect(sample > 0.3).toBe(true); // naive f64: blocked
    expect(sample > Math.fround(0.3)).toBe(false); // f32: equality -> lit
  });
});

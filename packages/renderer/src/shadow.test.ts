import { describe, expect, it } from "vitest";
import { HostBuffer, readElement } from "./buffer";
import {
  computeVisibility,
  isOccludedWithContext,
  marchShadowRay,
  prepareShadowContext,
  sampleHeightAt,
  traceShadowRay,
} from "./shadow";
import { createScene } from "./scene";
import type { Scene } from "./scene";

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
    expect(ctx.maxDistance).toBeCloseTo(Math.hypot(16, 16) / 0.5, 6);
    expect(ctx.bias).toBe(0.5);
    expect(ctx.stepSize).toBe(0.5);
    expect(ctx.maxHeight).toBe(6);
    // near-vertical light: no horizontal travel, diagonal is a harmless cap
    const vertical = prepareShadowContext(sceneWithLight({ x: 0, y: 0, z: 1 }), twoLevelHeight());
    expect(vertical.maxDistance).toBeCloseTo(Math.hypot(16, 16), 6);
  });

  it("canonicalizes the sanitized bias to f32 in the prepared context", () => {
    const ctx = prepareShadowContext(sceneWithLight(LIGHT_FROM_RIGHT), twoLevelHeight(), {
      bias: 0.1,
    });
    expect(ctx.bias).toBe(Math.fround(0.1));
    expect(ctx.bias).not.toBe(0.1); // f64 differs; the f32 value matches a WGSL uniform
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

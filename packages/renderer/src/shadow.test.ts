import { describe, expect, it } from "vitest";
import { HostBuffer, readElement } from "./buffer";
import { computeVisibility, sampleHeightAt, traceShadowRay } from "./shadow";
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

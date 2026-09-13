import { describe, expect, it } from "vitest";
import { createScene } from "./scene";
import { lightScene } from "./lighting";
import { composeSdfHeightField } from "./geometry";
import { NO_OWNER } from "./compose";
import { compositePixelBytes } from "./gpu/composite";
import { renderEmissiveEffects, sanitizeEmissiveEffects } from "./emissive-effects";

/**
 * #75: the base plane is a physical receiver when the scene declares a
 * `background` albedo, so base-plane pixels follow the SAME lighting equation
 * as owned surfaces (ambient + direct*visibility + environment + emissive
 * incident) instead of the legacy fixed `shadowColor` tint.
 */

const W = 200;
const H = 130;
const RECEIVER_ID = 2;
const BACKGROUND = { r: 0.2, g: 0.3, b: 0.5 };

function makeScene(emission: number, background: boolean) {
  return createScene({
    width: W,
    height: H,
    ...(background ? { background: BACKGROUND } : {}),
    surfaces: [
      { id: "blocker", position: { x: 150, y: 10 }, size: { x: 10, y: 100 }, elevation: 0, thickness: 20,
        shape: { kind: "roundedRect", radius: 1 }, profile: { kind: "flat" }, material: "matte", castsShadow: true, receivesShadow: true },
      { id: "emitter", position: { x: 110, y: 70 }, size: { x: 16, y: 16 }, elevation: 6, thickness: 2,
        shape: { kind: "roundedRect", radius: 2 }, profile: { kind: "flat" }, material: "lamp", castsShadow: true, receivesShadow: true },
      { id: "receiver", position: { x: 20, y: 70 }, size: { x: 120, y: 50 }, elevation: 1, thickness: 2,
        shape: { kind: "roundedRect", radius: 2 }, profile: { kind: "flat" }, material: "matte", castsShadow: true, receivesShadow: true },
    ],
    materials: {
      lamp: { baseColor: { r: 0, g: 0.1, b: 0.2 }, roughness: 1, metallic: 0, emissive: { r: 0.1 * emission, g: 0.6 * emission, b: emission } },
      matte: { baseColor: { r: 0.7, g: 0.7, b: 0.7 }, roughness: 1, metallic: 0 },
    },
    light: { direction: { x: 0.9, y: -0.35, z: 0.25 }, intensity: 1 },
    environment: { intensity: 0 },
    exposure: 1,
  });
}

function basePlanePixels(visibility: Float64Array, objectId: ArrayLike<number>): { lit: number[]; shadowed: number[] } {
  const lit: number[] = [];
  const shadowed: number[] = [];
  for (let i = 0; i < W * H; i++) {
    if (objectId[i] !== NO_OWNER) continue;
    if (visibility[i] >= 0.99) lit.push(i);
    else if (visibility[i] <= 0.01) shadowed.push(i);
  }
  return { lit, shadowed };
}

describe("#75 physical base plane", () => {
  it("sanitizes the base-plane albedo and uses it as the NO_OWNER receiver material", () => {
    const scene = createScene({ width: 4, height: 4, background: { r: 0.2, g: -1, b: 2 } });
    expect(scene.background).toEqual({ r: 0.2, g: 0, b: 1 });
  });

  it("shades base-plane pixels with direct*visibility (the shadow lives in the color)", () => {
    const scene = makeScene(0, true);
    const buffers = lightScene(scene, { ambient: 0 });
    const composed = composeSdfHeightField(scene);
    const vis = Float64Array.from(buffers.visibility!.data);
    const { lit, shadowed } = basePlanePixels(vis, composed.objectId.data);
    expect(lit.length).toBeGreaterThan(0);
    expect(shadowed.length).toBeGreaterThan(0);
    // With ambient/environment 0, a fully shadowed base-plane pixel is black
    // (direct * visibility === 0) and a fully lit one is non-black.
    for (const i of shadowed) {
      expect(buffers.color.data[i * 4]).toBe(0);
      expect(buffers.color.data[i * 4 + 1]).toBe(0);
      expect(buffers.color.data[i * 4 + 2]).toBe(0);
    }
    expect(buffers.color.data[lit[0] * 4 + 2]).toBeGreaterThan(0);
  });

  it("presents the physical base-plane color opaquely instead of a fixed tint", () => {
    const [r, g, b, a] = compositePixelBytes(NO_OWNER, 10, 20, 30, 0, { physicalBasePlane: true });
    expect([r, g, b, a]).toEqual([10, 20, 30, 255]);
    // legacy model still tints when the flag is off
    const legacy = compositePixelBytes(NO_OWNER, 10, 20, 30, 0, {});
    expect(legacy[3]).toBeGreaterThan(0);
  });

  it("brightens a shadowed base-plane pixel with emissive incident light (bloom off)", () => {
    const effects = sanitizeEmissiveEffects({ illumination: { intensity: 2, radius: 70 } });
    const run = (emission: number) => {
      const scene = makeScene(emission, true);
      const buffers = lightScene(scene, { ambient: 0 });
      const composed = composeSdfHeightField(scene);
      const out = renderEmissiveEffects(
        scene,
        { ...buffers, objectId: composed.objectId },
        effects,
        [12, 16, 28],
        0.3,
        1,
        true,
      );
      return { out, vis: Float64Array.from(buffers.visibility!.data), objectId: composed.objectId.data };
    };
    const off = run(0);
    const on = run(10);
    const { shadowed } = basePlanePixels(off.vis, off.objectId);
    expect(shadowed.length).toBeGreaterThan(100);
    let brighter = 0;
    for (const i of shadowed) {
      if (on.out[i * 4 + 1] > off.out[i * 4 + 1]) brighter++;
    }
    expect(brighter).toBeGreaterThan(shadowed.length * 0.5);
  });

  it("keeps the shadow visibility field unchanged by the emissive value", () => {
    const a = lightScene(makeScene(0, true), { ambient: 0 }).visibility!;
    const b = lightScene(makeScene(10, true), { ambient: 0 }).visibility!;
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
  });

  it("shares the same lighting equation for an owned receiver and the base plane", () => {
    // ambient/environment 0: both owned receiver and base plane are pure
    // direct*visibility. A shadowed pixel of each is exactly black.
    const scene = makeScene(0, true);
    const buffers = lightScene(scene, { ambient: 0 });
    const composed = composeSdfHeightField(scene);
    const objectId = composed.objectId.data;
    const vis = buffers.visibility!.data;
    let ownedShadowed = 0;
    let baseShadowed = 0;
    for (let i = 0; i < W * H; i++) {
      if (vis[i] > 0.01) continue;
      const black =
        buffers.color.data[i * 4] === 0 &&
        buffers.color.data[i * 4 + 1] === 0 &&
        buffers.color.data[i * 4 + 2] === 0;
      if (objectId[i] === RECEIVER_ID) {
        ownedShadowed++;
        expect(black).toBe(true);
      } else if (objectId[i] === NO_OWNER) {
        baseShadowed++;
        expect(black).toBe(true);
      }
    }
    expect(ownedShadowed).toBeGreaterThan(0);
    expect(baseShadowed).toBeGreaterThan(0);
  });
});

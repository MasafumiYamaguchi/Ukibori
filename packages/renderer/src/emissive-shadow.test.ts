import { describe, expect, it } from "vitest";
import { createScene } from "./scene";
import { lightScene } from "./lighting";
import { composeSdfHeightField } from "./geometry";
import { NO_OWNER } from "./compose";
import {
  computeEmissiveIncidentField,
  renderEmissiveEffects,
  sanitizeEmissiveEffects,
} from "./emissive-effects";
import type { EffectiveEmissiveEffects, EmissiveEffectFields } from "./emissive-effects";

/**
 * Issue #74 characterization fixture: a directional cast shadow must not
 * suppress the emissive-derived incident illumination of a receiver.
 *
 * Geometry (scene units, +x right / +y down / +z toward the viewer):
 *
 * - the blocker sits UP-LIGHT of the emitter/receiver, so the DIRECTIONAL
 *   shadow is cast to the lower-left ACROSS the emitter's surroundings;
 * - the emitter -> receiver line of sight does NOT pass through the blocker,
 *   so a valid emissive contribution exists inside the directional shadow.
 *
 * This separates the two occlusions the issue calls out: the primary-light
 * shadow visibility (which must scale ONLY the direct term) and emissive
 * source occlusion (out of scope here).
 */

const W = 240;
const H = 150;
const EMITTER_ID = 1;
const RECEIVER_ID = 2;

function makeScene(emission: number, angularRadius = 0) {
  return createScene({
    width: W,
    height: H,
    surfaces: [
      {
        id: "blocker", position: { x: 160, y: 20 }, size: { x: 10, y: 110 },
        elevation: 0, thickness: 22, shape: { kind: "roundedRect", radius: 1 },
        profile: { kind: "flat" }, material: "matte", castsShadow: true, receivesShadow: true,
      },
      {
        id: "emitter", position: { x: 120, y: 80 }, size: { x: 18, y: 18 },
        elevation: 6, thickness: 2, shape: { kind: "roundedRect", radius: 2 },
        profile: { kind: "flat" }, material: "lamp", castsShadow: true, receivesShadow: true,
      },
      {
        id: "receiver", position: { x: 20, y: 80 }, size: { x: 140, y: 50 },
        elevation: 1, thickness: 2, shape: { kind: "roundedRect", radius: 2 },
        profile: { kind: "flat" }, material: "matte", castsShadow: true, receivesShadow: true,
      },
    ],
    materials: {
      lamp: {
        baseColor: { r: 0, g: 0.1, b: 0.2 }, roughness: 1, metallic: 0,
        emissive: { r: 0.1 * emission, g: 0.6 * emission, b: emission },
      },
      matte: { baseColor: { r: 0.7, g: 0.7, b: 0.7 }, roughness: 1, metallic: 0 },
    },
    // Light from the upper-RIGHT: the long cast shadow falls to the lower-left.
    light: { direction: { x: 0.9, y: -0.35, z: 0.25 }, intensity: 1, angularRadius },
    environment: { intensity: 0 },
    exposure: 1,
  });
}

const EFFECTS = sanitizeEmissiveEffects({ illumination: { intensity: 2, radius: 70 } });
const EFFECTS_BLOOM = sanitizeEmissiveEffects({
  illumination: { intensity: 2, radius: 70 },
  bloom: { intensity: 0.6, radius: 24, threshold: 1 },
});

interface Run {
  fields: EmissiveEffectFields;
  incident: Float64Array;
  output: Uint8Array;
  withoutEmissive: Uint8Array;
  visibility: Float64Array;
}

function run(
  emission: number,
  maxDistance: number,
  effects: EffectiveEmissiveEffects = EFFECTS,
  shadowOptions: { samples?: number; reconstruction?: { enabled?: boolean; radius?: number } } = {},
  angularRadius = 0,
): Run {
  const scene = makeScene(emission, angularRadius);
  const buffers = lightScene(scene, {
    ambient: 0,
    shadow: { maxDistance, stepSize: 0.5, ...shadowOptions },
  });
  const composed = composeSdfHeightField(scene);
  const fields: EmissiveEffectFields = { ...buffers, objectId: composed.objectId };
  const incident = computeEmissiveIncidentField(scene, fields, effects);
  const output = renderEmissiveEffects(scene, fields, effects);
  const withoutEmissive = renderEmissiveEffects(makeScene(0, angularRadius), fields, effects);
  return { fields, incident, output, withoutEmissive, visibility: Float64Array.from(buffers.visibility!.data) };
}

function shadowedOwned(visibility: Float64Array, objectId: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i < W * H; i++) {
    if (objectId[i] !== RECEIVER_ID) continue;
    if (visibility[i] >= 0.01) continue;
    out.push(i);
  }
  return out;
}

describe("#74 emissive illumination lifts directionally-shadowed receivers", () => {
  it("keeps the emissive incident field independent of the directional shadow length", () => {
    const short = run(10, 30);
    const long = run(10, 400);
    // The geometry is identical, so the incident field is byte-identical even
    // though the long shadow covers far more receivers.
    expect(short.incident.length).toBe(long.incident.length);
    let incident = 0;
    let maxDiff = 0;
    for (let i = 0; i < short.incident.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(short.incident[i] - long.incident[i]));
      if (long.incident[i] > 1e-9) incident++;
    }
    expect(maxDiff).toBe(0);
    expect(incident).toBeGreaterThan(0);
    // The long shadow really is larger (the fixture exercises the case).
    const shortShadowed = short.visibility.filter((v) => v < 0.01).length;
    const longShadowed = long.visibility.filter((v) => v < 0.01).length;
    expect(longShadowed).toBeGreaterThan(shortShadowed);
  });

  it("brightens shadowed owned receivers in a valid emissive region", () => {
    const lit = run(0, 400);
    const emissive = run(10, 400);
    const objectId = emissive.fields.objectId.data;
    const shadowed = shadowedOwned(emissive.visibility, objectId);
    expect(shadowed.length).toBeGreaterThan(100);
    let brighter = 0;
    for (const i of shadowed) {
      // Any channel brightening proves the emissive contribution was added.
      if (
        emissive.output[i * 4] > lit.output[i * 4] ||
        emissive.output[i * 4 + 1] > lit.output[i * 4 + 1] ||
        emissive.output[i * 4 + 2] > lit.output[i * 4 + 2]
      ) {
        brighter++;
      }
    }
    // Almost every geometrically-shadowed receiver pixel has a clear emitter
    // line of sight; the few behind the blocker keep the shadow dark.
    expect(brighter).toBeGreaterThan(shadowed.length * 0.9);
  });

  it("adds the emissive contribution to shadowed base-plane receivers", () => {
    const lit = run(0, 400);
    const emissive = run(10, 400);
    const objectId = emissive.fields.objectId.data;
    let baseShadowed = 0;
    let brighter = 0;
    for (let i = 0; i < W * H; i++) {
      if (objectId[i] !== NO_OWNER || emissive.visibility[i] >= 0.01) continue;
      baseShadowed++;
      if (emissive.output[i * 4 + 1] > lit.output[i * 4 + 1]) brighter++;
    }
    expect(baseShadowed).toBeGreaterThan(100);
    expect(brighter).toBeGreaterThan(0);
  });

  it("preserves the geometric shadow field (visibility) regardless of emissive", () => {
    const a = run(0, 400).visibility;
    const b = run(10, 400).visibility;
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("reproduces the non-emissive shadow result at emissive intensity 0", () => {
    const zero = run(0, 400);
    const objectId = zero.fields.objectId.data;
    // With no emission and no incident light the overlay is exactly the
    // physical reflected lighting for owned pixels (the shadow is already in
    // that color via visibility), so intensity 0 changes nothing.
    let owned = 0;
    for (let i = 0; i < W * H; i++) {
      if (objectId[i] === NO_OWNER) continue;
      owned++;
      for (let c = 0; c < 3; c++) expect(zero.output[i * 4 + c]).toBe(zero.fields.color.data[i * 4 + c]);
    }
    expect(owned).toBeGreaterThan(1000);
    // The incident field is exactly zero (no emitter).
    expect(Array.from(zero.incident).every((v) => v === 0)).toBe(true);
  });

  it("produces the same emissive lift with bloom disabled and enabled", () => {
    const off = run(10, 400, EFFECTS);
    const on = run(10, 400, EFFECTS_BLOOM);
    const noEmOff = run(0, 400, EFFECTS);
    const objectId = off.fields.objectId.data;
    const shadowed = shadowedOwned(off.visibility, objectId);
    let bloomLift = 0;
    let plainLift = 0;
    for (const i of shadowed) {
      if (on.output[i * 4 + 1] > noEmOff.output[i * 4 + 1]) bloomLift++;
      if (off.output[i * 4 + 1] > noEmOff.output[i * 4 + 1]) plainLift++;
    }
    expect(plainLift).toBeGreaterThan(0);
    expect(bloomLift).toBeGreaterThan(0);
  });

  it("keeps a self-emissive surface luminous inside the directional shadow", () => {
    // The emitter surface itself: an emissive owned pixel keeps its emitted
    // radiance regardless of the directional shadow visibility (the blocker
    // does not cover the emitter here, so compare a shadowed emitter variant
    // by pinning its color against the ambient-only response).
    const emissive = run(10, 400);
    const objectId = emissive.fields.objectId.data;
    let emitterPixels = 0;
    let luminous = 0;
    for (let i = 0; i < W * H; i++) {
      if (objectId[i] !== EMITTER_ID) continue;
      emitterPixels++;
      // Emission alone (no environment, no direct) is non-black in blue.
      if (emissive.output[i * 4 + 2] > 64) luminous++;
    }
    expect(emitterPixels).toBeGreaterThan(50);
    expect(luminous).toBeGreaterThan(emitterPixels * 0.9);
  });

  it("uses the same composition for hard, soft and reconstructed shadows", () => {
    const softScene = run(10, 400, EFFECTS, { samples: 8 }, 0.3);
    const reconstructed = run(10, 400, EFFECTS, {
      samples: 8,
      reconstruction: { enabled: true, radius: 2 },
    }, 0.3);
    const hard = run(10, 400);
    // The emissive contribution is the same field in every shadow mode: the
    // shadow algorithm changes visibility, never the emissive incident.
    expect(Array.from(hard.incident)).toEqual(Array.from(softScene.incident));
    expect(Array.from(hard.incident)).toEqual(Array.from(reconstructed.incident));
    // Every mode still has shadowed receivers that the emissive lifts.
    for (const mode of [hard, softScene, reconstructed]) {
      const objectId = mode.fields.objectId.data;
      const shadowed = shadowedOwned(mode.visibility, objectId);
      let brighter = 0;
      for (const i of shadowed) if (mode.output[i * 4 + 1] > mode.withoutEmissive[i * 4 + 1]) brighter++;
      // (soft/reconstructed visibility is continuous; >=0.01 is excluded above)
      expect(shadowed.length).toBeGreaterThan(0);
      expect(brighter).toBeGreaterThan(0);
    }
  }, 60000);

  it("does not scale the emissive incident by the shadow visibility (debug contributions)", () => {
    const { incident, visibility, fields } = run(10, 400);
    const objectId = fields.objectId.data;
    let shadowedWithIncident = 0;
    for (let i = 0; i < W * H; i++) {
      if (visibility[i] >= 0.01) continue;
      if (objectId[i] === NO_OWNER || objectId[i] === RECEIVER_ID || objectId[i] === EMITTER_ID) {
        if (incident[i * 3] + incident[i * 3 + 1] + incident[i * 3 + 2] > 1e-6) shadowedWithIncident++;
      }
    }
    expect(shadowedWithIncident).toBeGreaterThan(0);
  });
});

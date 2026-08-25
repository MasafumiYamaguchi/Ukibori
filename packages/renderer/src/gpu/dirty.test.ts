import { describe, expect, it } from "vitest";
import { createScene } from "../scene";
import type { SceneInput } from "../scene";
import {
  ALL_STAGES,
  REASON_STAGES,
  classifySceneChange,
  computeFrameKey,
  computeInvalidationReasons,
  fingerprintBytes,
  reportInvalidations,
  stagesForReasons,
} from "./dirty";
import { encodeScene } from "./encode";
import { heightInputsMatchScene } from "./height-inputs";

const BASE: SceneInput = {
  width: 100,
  height: 80,
  surfaces: [
    {
      id: "a",
      position: { x: 10, y: 10 },
      size: { x: 40, y: 30 },
      elevation: 2,
      thickness: 2,
      shape: { kind: "roundedRect", radius: 0 },
      profile: { kind: "flat" },
      material: "silicone",
      castsShadow: true,
      receivesShadow: true,
    },
  ],
  light: { direction: { x: -0.70710678, y: 0, z: 0.70710678 }, intensity: 1 },
};

function key(dpr = 1, options: { normal?: object; shadow?: object; lighting?: object; composite?: object } = {}) {
  const scene = createScene({ ...BASE });
  const encoded = encodeScene(scene, dpr);
  return computeFrameKey(encoded, {
    dpr,
    normalOptions: options.normal,
    shadowOptions: options.shadow,
    lightingOptions: options.lighting,
    compositeOptions: options.composite,
  });
}

/** Encode a BASE variant and return { key, bytes } for exact-byte tests. */
function encoded(input: Partial<SceneInput> = {}) {
  const scene = createScene({ ...BASE, ...input });
  const bytes = encodeScene(scene, 1).bytes;
  return { key: computeFrameKey({ bytes }, { dpr: 1 }), bytes };
}

/** Report helper: pass the exact bytes of both scenes (semantic diff). */
function report(
  next: ReturnType<typeof encoded>,
  prev: ReturnType<typeof encoded>,
  repaint = false,
) {
  return reportInvalidations(next.key, prev.key, next.bytes, prev.bytes, repaint);
}

describe("#31 invalidation dependency graph — stagesForReasons / REASON_STAGES", () => {
  it("maps every reason to exactly the brief's downstream closure", () => {
    expect(REASON_STAGES["first-frame"]).toEqual(ALL_STAGES);
    expect(REASON_STAGES.viewport).toEqual(ALL_STAGES);
    expect(REASON_STAGES.scene).toEqual(ALL_STAGES);
    expect(REASON_STAGES["normal-options"]).toEqual(["normal", "lighting", "presentation"]);
    expect(REASON_STAGES["shadow-options"]).toEqual([
      "shadow",
      "reconstruction",
      "lighting",
      "presentation",
    ]);
    // #43: a reconstruction-only option change re-runs the filter and its
    // consumers; the raw shadow field stays retained.
    expect(REASON_STAGES["reconstruction-options"]).toEqual([
      "reconstruction",
      "lighting",
      "presentation",
    ]);
    // #43: every reason that invalidates shadow also re-runs reconstruction.
    expect(REASON_STAGES["light-direction"]).toContain("reconstruction");
    expect(REASON_STAGES["light-angular-radius"]).toContain("reconstruction");
    expect(REASON_STAGES["lighting-options"]).toEqual(["lighting", "presentation"]);
    expect(REASON_STAGES["composite-options"]).toEqual(["presentation"]);
    expect(REASON_STAGES["debug-target"]).toEqual(["presentation"]);
  });

  it("unions multiple reasons in canonical order without duplicates", () => {
    expect(stagesForReasons([])).toEqual([]);
    expect(stagesForReasons(["composite-options", "lighting-options"])).toEqual([
      "lighting",
      "presentation",
    ]);
    expect(stagesForReasons(["scene", "normal-options"])).toEqual(ALL_STAGES);
  });
});

describe("#31 stable canonical fingerprints", () => {
  it("is deterministic and object-identity independent", () => {
    // two equivalent scenes created independently encode to identical bytes
    const a = encodeScene(createScene({ ...BASE }), 1);
    const b = encodeScene(createScene({ ...BASE }), 1);
    expect(a.bytes).not.toBe(b.bytes);
    expect(fingerprintBytes(a.bytes)).toBe(fingerprintBytes(b.bytes));
    expect(fingerprintBytes(a.bytes)).toBe(
      `${a.bytes.byteLength}:${fingerprintBytes(a.bytes).split(":")[1]}`,
    );
    // length prefix is part of the fingerprint
    const longer = new Uint8Array(a.bytes.byteLength + 1);
    longer.set(a.bytes);
    longer[a.bytes.byteLength] = 0;
    expect(fingerprintBytes(longer)).not.toBe(fingerprintBytes(a.bytes));
  });

  it("reflects every encoding-relevant input", () => {
    const surface = BASE.surfaces![0]!;
    const moved = createScene({
      ...BASE,
      surfaces: [{ ...surface, position: { x: 11, y: 10 } }],
    });
    const lighter = createScene({
      ...BASE,
      light: { direction: { x: 0, y: 0, z: 1 }, intensity: 2 },
    });
    const keyBase = key();
    expect(key(1).scene).toBe(keyBase.scene);
    expect(computeFrameKey(encodeScene(moved, 1), { dpr: 1 }).scene).not.toBe(keyBase.scene);
    expect(computeFrameKey(encodeScene(lighter, 1), { dpr: 1 }).scene).not.toBe(keyBase.scene);
    expect(key(2).viewport).not.toBe(key(1).viewport);
  });

  it("does not collide an explicit shadow value with a context-derived default", () => {
    const current = encoded();
    const explicit = computeFrameKey(
      { bytes: current.bytes },
      { dpr: 1, shadowOptions: { maxDistance: 1 } },
    );
    const derivedDefault = computeFrameKey({ bytes: current.bytes }, { dpr: 1 });

    expect(explicit.shadow).not.toBe(derivedDefault.shadow);
    const diff = reportInvalidations(
      derivedDefault,
      explicit,
      current.bytes,
      current.bytes,
    );
    expect(diff.reasons).toEqual(["shadow-options"]);
    expect(diff.executed).toEqual(["shadow", "reconstruction", "lighting", "presentation"]);
  });

  it("reduces options to their sanitized effective values", () => {
    // raw NaN falls back to the default, so it must NOT invalidate
    expect(key(1, { normal: { scaleX: NaN } }).normal).toBe(key(1).normal);
    expect(key(1, { shadow: { bias: Infinity } }).shadow).toBe(key(1).shadow);
    expect(key(1, { lighting: { ambient: NaN } }).lighting).toBe(key(1).lighting);
    // distinct effective values DO invalidate
    expect(key(1, { normal: { scaleX: 0.9 } }).normal).not.toBe(key(1).normal);
    expect(key(1, { shadow: { bias: 0.25 } }).shadow).not.toBe(key(1).shadow);
    expect(key(1, { lighting: { ambient: 0.3 } }).lighting).not.toBe(key(1).lighting);
    expect(key(1, { composite: { shadowAlpha: 0.6 } }).composite).not.toBe(key(1).composite);
  });

  it("separates the debug target from the production configuration", () => {
    const scene = createScene({ ...BASE });
    const encoded = encodeScene(scene, 1);
    const prod = computeFrameKey(encoded, { dpr: 1 });
    const debug = computeFrameKey(encoded, { dpr: 1, debugReadback: true });
    expect(prod.debugTarget).toBe("prod");
    expect(debug.debugTarget).toBe("debug");
    expect(computeInvalidationReasons(debug, prod, encoded.bytes, encoded.bytes)).toEqual([
      "debug-target",
    ]);
  });
});

describe("#31 reportInvalidations", () => {
  it("invalidates everything on the first frame", () => {
    const current = encoded();
    const report = reportInvalidations(current.key, null, current.bytes, null, false);
    expect(report.reasons).toEqual(["first-frame"]);
    expect(report.executed).toEqual(ALL_STAGES);
    expect(report.skipped).toEqual([]);
    expect(report.retained).toBe(false);
  });

  it("reports a byte-identical repeated frame as fully retained", () => {
    const current = encoded();
    const report = reportInvalidations(current.key, current.key, current.bytes, current.bytes, false);
    expect(report.reasons).toEqual([]);
    expect(report.executed).toEqual([]);
    expect(report.skipped).toEqual(ALL_STAGES);
    expect(report.retained).toBe(true);
  });

  it("adds only presentation for a requested retained repaint", () => {
    const current = encoded();
    const report = reportInvalidations(current.key, current.key, current.bytes, current.bytes, true);
    expect(report.reasons).toEqual([]);
    expect(report.executed).toEqual(["presentation"]);
    expect(report.skipped).toEqual([
      "upload",
      "height",
      "normal",
      "shadow",
      "reconstruction",
      "lighting",
    ]);
    expect(report.retained).toBe(false);
  });

  it("propagates each option change to only its downstream closure", () => {
    const base = key();
    const current = encoded();
    expect(reportInvalidations(key(1, { normal: { scaleX: 0.9 } }), base, current.bytes, current.bytes, false).executed).toEqual([
      "normal",
      "lighting",
      "presentation",
    ]);
    expect(reportInvalidations(key(1, { shadow: { bias: 0.25 } }), base, current.bytes, current.bytes, false).executed).toEqual([
      "shadow",
      "reconstruction",
      "lighting",
      "presentation",
    ]);
    // #43: a reconstruction-only change re-runs the filter + its consumers
    // while the raw shadow field stays retained.
    const reconOnly = reportInvalidations(
      key(1, { shadow: { reconstruction: { radius: 3 } } }),
      base,
      current.bytes,
      current.bytes,
      false,
    );
    expect(reconOnly.reasons).toEqual(["reconstruction-options"]);
    expect(reconOnly.executed).toEqual(["reconstruction", "lighting", "presentation"]);
    expect(reconOnly.skipped).toContain("shadow");
    // disabling reconstruction is the same closure (the consumers must
    // switch back to the raw field)
    expect(
      reportInvalidations(
        key(1, { shadow: { reconstruction: { enabled: false } } }),
        base,
        current.bytes,
        current.bytes,
        false,
      ).executed,
    ).toEqual(["reconstruction", "lighting", "presentation"]);
    expect(reportInvalidations(key(1, { lighting: { ambient: 0.3 } }), base, current.bytes, current.bytes, false).executed).toEqual([
      "lighting",
      "presentation",
    ]);
    expect(
      reportInvalidations(key(1, { composite: { shadowAlpha: 0.6 } }), base, current.bytes, current.bytes, false).executed,
    ).toEqual(["presentation"]);
  });

  it("treats a stale (null) previous key as first-frame even with equal fingerprints", () => {
    const current = encoded();
    expect(reportInvalidations(current.key, null, current.bytes, null, false).reasons).toEqual([
      "first-frame",
    ]);
  });

  it("classifies a light direction change as upload/shadow/lighting/presentation only", () => {
    const prev = encoded();
    const next = encoded({
      light: { direction: { x: 0, y: 0, z: 1 }, intensity: 1 },
    });
    const diff = report(next, prev);
    expect(diff.reasons).toEqual(["light-direction"]);
    expect(diff.executed).toEqual(["upload", "shadow", "reconstruction", "lighting", "presentation"]);
    expect(diff.skipped).toEqual(["height", "normal"]);
    expect(diff.retained).toBe(false);
  });

  it("classifies a #41 light angular radius change as upload/shadow/lighting/presentation only", () => {
    const prev = encoded();
    const next = encoded({
      light: {
        direction: BASE.light?.direction ?? { x: 0, y: 0, z: 1 },
        intensity: BASE.light?.intensity ?? 1,
        angularRadius: Math.fround(0.15),
      },
    });
    const diff = report(next, prev);
    // The cone directions feed ONLY the shadow stage (and downstream
    // visibility consumers): height/normal stay retained.
    expect(diff.reasons).toEqual(["light-angular-radius"]);
    expect(diff.executed).toEqual(["upload", "shadow", "reconstruction", "lighting", "presentation"]);
    expect(diff.skipped).toEqual(["height", "normal"]);
    expect(diff.retained).toBe(false);
    // and back: clearing the radius classifies the same way
    const back = report(prev, next);
    expect(back.reasons).toEqual(["light-angular-radius"]);
    expect(back.skipped).toEqual(["height", "normal"]);
  });

  it("classifies a light intensity change as upload/lighting/presentation only", () => {
    const prev = encoded();
    const next = encoded({
      light: { direction: { x: -0.70710678, y: 0, z: 0.70710678 }, intensity: 2 },
    });
    const diff = report(next, prev);
    expect(diff.reasons).toEqual(["light-intensity"]);
    expect(diff.executed).toEqual(["upload", "lighting", "presentation"]);
    expect(diff.skipped).toEqual(["height", "normal", "shadow", "reconstruction"]);
  });

  it("classifies environment and exposure changes as upload/lighting/presentation only", () => {
    const prev = encoded();
    const env = encoded({
      light: { direction: { x: -0.70710678, y: 0, z: 0.70710678 }, intensity: 1 },
      environment: { intensity: 0.9, diffuseIntensity: 0.8, specularIntensity: 0.7 },
    });
    expect(report(env, prev).reasons).toEqual(["environment"]);
    expect(report(env, prev).executed).toEqual(["upload", "lighting", "presentation"]);

    const exposure = encoded({
      light: { direction: { x: -0.70710678, y: 0, z: 0.70710678 }, intensity: 1 },
      exposure: 1.5,
    });
    expect(report(exposure, prev).reasons).toEqual(["environment"]);
    expect(report(exposure, prev).executed).toEqual(["upload", "lighting", "presentation"]);
  });

  it("classifies a material table value change as upload/lighting/presentation only", () => {
    const prev = encoded();
    const next = encoded({
      materials: {
        silicone: { baseColor: { r: 0.9, g: 0.85, b: 0.8 }, roughness: 0.4, metallic: 0, ior: 1.45 },
      },
    });
    const diff = report(next, prev);
    expect(diff.reasons).toEqual(["material-values"]);
    expect(diff.executed).toEqual(["upload", "lighting", "presentation"]);
    expect(diff.skipped).toEqual(["height", "normal", "shadow", "reconstruction"]);
  });

  it("unions multiple semantic scene changes into one downstream closure", () => {
    const prev = encoded();
    const next = encoded({
      light: { direction: { x: 0, y: 0, z: 1 }, intensity: 2 },
      exposure: 1.5,
      materials: {
        silicone: { baseColor: { r: 0.9, g: 0.85, b: 0.8 }, roughness: 0.4, metallic: 0, ior: 1.45 },
      },
    });
    const diff = report(next, prev);
    expect(diff.reasons).toEqual(["light-direction", "light-intensity", "environment", "material-values"]);
    expect(diff.executed).toEqual(["upload", "shadow", "reconstruction", "lighting", "presentation"]);
    expect(diff.skipped).toEqual(["height", "normal"]);
  });

  it("keeps the conservative full chain for height-input and structural changes", () => {
    const prev = encoded();
    const moved = encoded({
      surfaces: [
        {
          id: "a",
          position: { x: 11, y: 10 },
          size: { x: 40, y: 30 },
          elevation: 2,
          thickness: 2,
          shape: { kind: "roundedRect", radius: 0 },
          profile: { kind: "flat" },
          material: "silicone",
          castsShadow: true,
          receivesShadow: true,
        },
      ],
    });
    expect(report(moved, prev).reasons).toEqual(["scene"]);
    expect(report(moved, prev).executed).toEqual(ALL_STAGES);

    const resized = encoded({ width: 120, height: 80 });
    expect(report(resized, prev).reasons).toEqual(["scene", "viewport"]);
  });
});

describe("classifySceneChange — exact-byte semantic classification", () => {
  it("returns [] for byte-identical scenes", () => {
    const current = encoded();
    expect(classifySceneChange(current.bytes, current.bytes)).toEqual([]);
  });

  it("classifies a byte-length change as the conservative full chain", () => {
    const a = encoded();
    const b = new Uint8Array(a.bytes.byteLength + 1);
    b.set(a.bytes);
    expect(classifySceneChange(a.bytes, b)).toEqual(["scene"]);
  });

  it("never authorizes reuse from a hash alone: equal hash + different bytes -> scene", () => {
    const a = encoded();
    const b = a.bytes.slice(); // byte-identical copy, fresh buffer
    const forgedKey = computeFrameKey({ bytes: b }, { dpr: 1 }); // same hash
    b[10] = (b[10]! + 1) & 0xff; // bytes now genuinely differ under the equal hash
    expect(forgedKey.scene).toBe(a.key.scene);
    expect(fingerprintBytes(b)).not.toBe(a.key.scene);
    const reasons = computeInvalidationReasons(
      { ...a.key, scene: forgedKey.scene },
      a.key,
      b,
      a.bytes,
    );
    expect(reasons).toEqual(["scene"]);
  });

  it("classifies a material FLAGS change as the full chain (height-dependent)", () => {
    const prev = encoded();
    const next = encoded({
      materials: {
        silicone: { baseColor: { r: 0.9, g: 0.85, b: 0.8 }, roughness: 0.4, metallic: 0, ior: 1.45 },
      },
    });
    // mutate ONLY the material flags byte (offset 24 of the first record);
    // flags are height-dependent (the material-id output reads them) and
    // must NOT be classified as a material-values change
    const bytes = next.bytes.slice();
    // materials section starts after header + surfaces + masks:
    // 128 + 1*128 + 0*32 = 256; flags at 256 + 24
    bytes[256 + 24] = 1;
    expect(classifySceneChange(prev.bytes, bytes)).toEqual(["scene"]);
  });

  it("recomputes canonical height ranges instead of trusting forged metadata", () => {
    const prev = encoded();
    const surface = BASE.surfaces![0]!;
    const moved = encoded({
      surfaces: [{ ...surface, position: { x: 11, y: 10 } }],
    });
    expect(
      heightInputsMatchScene(
        {
          sceneBytes: prev.bytes,
          heightInputs: [{ offset: 0, byteLength: 0 }],
        },
        moved.bytes,
      ),
    ).toBe(false);
  });
});

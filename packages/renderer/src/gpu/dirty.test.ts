import { describe, expect, it } from "vitest";
import { createScene } from "../scene";
import type { SceneInput, SurfaceNode } from "../scene";
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
    // #43 review: option fingerprints are retained independently of the
    // semantic reasons — this direction change also moved |light.xy|, which
    // shifts the context-derived default maxDistance, so the EFFECTIVE
    // shadow options changed too and shadow-options legitimately fires.
    expect(diff.reasons).toEqual(["light-direction", "shadow-options"]);
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
    // the direction change shifted |light.xy| -> the context-derived shadow
    // default changed too, so shadow-options fires alongside the semantic
    // reasons (#43 review: option fingerprints are never swallowed).
    expect(diff.reasons).toEqual([
      "light-direction",
      "light-intensity",
      "environment",
      "material-values",
      "shadow-options",
    ]);
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
    // flags are height-dependent (the material-id output reads them) and the
    // change must NEVER be classified as a PURE material-values change (the
    // flags field is part of the table bytes, so the VALUES comparison also
    // fires — but the `scene` reason guarantees the full chain, and the
    // union never drops the height stage)
    const bytes = next.bytes.slice();
    // materials section starts after header + surfaces + masks:
    // 128 + 1*128 + 0*32 = 256; flags at 256 + 24
    bytes[256 + 24] = 1;
    expect(classifySceneChange(prev.bytes, bytes)).toEqual(["scene", "material-values"]);
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

describe("#43 geometry + global shadow/reconstruction change composition", () => {
  // The review pin: a geometry edit combined with a GLOBAL shadow /
  // reconstruction semantic change must keep BOTH reasons — never swallow
  // the option reason behind "scene" — so the planner can refuse the
  // partial path (a partial update with changed global semantics would mix
  // new and retained visibility semantics frame-wide).

  const movedSurface = { ...BASE.surfaces![0]!, position: { x: 12, y: 11 } };

  /** Encode two frames (scenes + optional shadow options) and diff them. */
  function diffFrames(
    prevScene: SceneInput,
    prevOptions: object | undefined,
    nextScene: SceneInput,
    nextOptions: object | undefined,
  ) {
    const prevBytes = encodeScene(createScene(prevScene), 1).bytes;
    const nextBytes = encodeScene(createScene(nextScene), 1).bytes;
    const prevKey = computeFrameKey({ bytes: prevBytes }, { dpr: 1, shadowOptions: prevOptions });
    const nextKey = computeFrameKey({ bytes: nextBytes }, { dpr: 1, shadowOptions: nextOptions });
    return reportInvalidations(nextKey, prevKey, nextBytes, prevBytes);
  }

  const base = { ...BASE, light: { direction: { x: -0.6, y: -0.8, z: 1 }, intensity: 1 } };
  const moved = { ...BASE, surfaces: [movedSurface], light: base.light };

  it("keeps light-angular-radius alongside a geometry change", () => {
    const prev = { ...base, light: { ...base.light, angularRadius: Math.fround(0.1) } };
    const next = { ...moved, light: { ...moved.light, angularRadius: Math.fround(0.2) } };
    const diff = diffFrames(prev, undefined, next, undefined);
    expect(diff.reasons).toContain("scene");
    expect(diff.reasons).toContain("light-angular-radius");
  });

  it("keeps shadow-options alongside a geometry change (samples/stepSize/bias/maxDistance)", () => {
    for (const [prevOpts, nextOpts] of [
      [{ samples: 4 }, { samples: 16 }],
      [{ stepSize: 0.5 }, { stepSize: 0.25 }],
      [{ bias: 0.5 }, { bias: 1 }],
      [{ maxDistance: 10 }, { maxDistance: 30 }],
    ] as const) {
      const diff = diffFrames(base, prevOpts, moved, nextOpts);
      expect(diff.reasons).toContain("scene");
      expect(diff.reasons).toContain("shadow-options");
    }
  });

  it("keeps reconstruction-options alongside a geometry change (radius/enabled/heightGate)", () => {
    for (const [prevOpts, nextOpts] of [
      [{ samples: 4, reconstruction: { enabled: true, radius: 2 } }, { samples: 4, reconstruction: { enabled: true, radius: 4 } }],
      [{ samples: 4, reconstruction: { enabled: true, radius: 2 } }, { samples: 4, reconstruction: { enabled: false } }],
      [{ samples: 4, reconstruction: { enabled: false } }, { samples: 4, reconstruction: { enabled: true, radius: 2 } }],
      [{ samples: 4, reconstruction: { heightGate: 0.5 } }, { samples: 4, reconstruction: { heightGate: 1 } }],
    ] as const) {
      const diff = diffFrames(base, prevOpts, moved, nextOpts);
      expect(diff.reasons).toContain("scene");
      expect(diff.reasons).toContain("reconstruction-options");
    }
  });

  it("keeps shadow-options AND reconstruction-options alongside a geometry change", () => {
    const diff = diffFrames(
      base,
      { samples: 4, reconstruction: { enabled: true, radius: 2 } },
      moved,
      { samples: 16, reconstruction: { enabled: true, radius: 4 } },
    );
    expect(diff.reasons).toContain("scene");
    expect(diff.reasons).toContain("shadow-options");
    expect(diff.reasons).toContain("reconstruction-options");
  });

  it("keeps light-angular-radius alongside geometry + option changes (hard<->soft combined)", () => {
    const prev = { ...base, light: { ...base.light, angularRadius: Math.fround(0.2) } };
    const next = { ...moved, light: { ...moved.light, angularRadius: 0 } };
    const diff = diffFrames(prev, { samples: 8 }, next, { samples: 8 });
    expect(diff.reasons).toContain("scene");
    expect(diff.reasons).toContain("light-angular-radius");
    // hard<->soft transitions with geometry are full by composition
    expect(diff.executed).toEqual(ALL_STAGES);
  });
});

describe("#43 geometry + material-value change composition", () => {
  // The review pin: material VALUES are frame-global LIGHTING semantics.
  // A geometry edit combined with a material table value change must keep
  // "material-values" alongside "scene" — the planner then refuses the
  // partial path (a partial update would light the dirty band with the NEW
  // material and the retained region with the OLD one).

  const GRAY = { r: 0.8, g: 0.8, b: 0.8 };
  const RED = { r: 1, g: 0.1, b: 0.1 };
  const BASE_MATS: SceneInput["materials"] = {
    silicone: { baseColor: GRAY, roughness: 0.5, metallic: 0, ior: 1.45 },
  };
  const matScene = (over: Partial<SceneInput> = {}): SceneInput => ({
    width: 100,
    height: 80,
    surfaces: [
      {
        id: "panel",
        position: { x: 0, y: 0 },
        size: { x: 100, y: 80 },
        elevation: 0,
        thickness: 0,
        shape: { kind: "roundedRect", radius: 0 },
        profile: { kind: "flat" },
        material: "silicone",
        castsShadow: false,
        receivesShadow: true,
      },
      {
        id: "btn",
        position: { x: 10, y: 10 },
        size: { x: 20, y: 20 },
        elevation: 2,
        thickness: 2,
        shape: { kind: "roundedRect", radius: 0 },
        profile: { kind: "flat" },
        material: "silicone",
        castsShadow: true,
        receivesShadow: true,
      },
    ],
    materials: BASE_MATS,
    light: { direction: { x: -0.6, y: -0.8, z: 1 }, intensity: 1 },
    ...over,
  });

  // a tiny ADDED surface reusing the EXISTING "silicone" material: surface
  // count changes, material count does NOT
  const chip: SurfaceNode = {
    id: "chip",
    position: { x: 80, y: 60 },
    size: { x: 6, y: 6 },
    elevation: 1,
    thickness: 1,
    shape: { kind: "roundedRect", radius: 0 },
    profile: { kind: "flat" },
    material: "silicone",
    castsShadow: true,
    receivesShadow: true,
  };

  function diffMaterialFrame(prevScene: SceneInput, nextScene: SceneInput) {
    const prevBytes = encodeScene(createScene(prevScene), 1).bytes;
    const nextBytes = encodeScene(createScene(nextScene), 1).bytes;
    const prevKey = computeFrameKey({ bytes: prevBytes }, { dpr: 1 });
    const nextKey = computeFrameKey({ bytes: nextBytes }, { dpr: 1 });
    return reportInvalidations(nextKey, prevKey, nextBytes, prevBytes);
  }

  it("Case 1: geometry-only keeps partial eligibility (no material-values)", () => {
    const prev = matScene();
    const next = matScene({ surfaces: [...matScene().surfaces!, chip] });
    const diff = diffMaterialFrame(prev, next);
    expect(diff.reasons).toEqual(["scene"]);
    expect(diff.reasons).not.toContain("material-values");
    expect(diff.executed).toEqual(ALL_STAGES);
  });

  it("Case 2: geometry + baseColor value change keeps material-values (full)", () => {
    const prev = matScene();
    const next = matScene({
      surfaces: [...matScene().surfaces!, chip],
      materials: { silicone: { ...BASE_MATS.silicone!, baseColor: RED } },
    });
    const diff = diffMaterialFrame(prev, next);
    expect(diff.reasons).toEqual(["scene", "material-values"]);
  });

  it("Case 3: geometry + roughness change keeps material-values", () => {
    const prev = matScene();
    const next = matScene({
      surfaces: [...matScene().surfaces!, chip],
      materials: { silicone: { ...BASE_MATS.silicone!, roughness: 0.8 } },
    });
    expect(diffMaterialFrame(prev, next).reasons).toEqual(["scene", "material-values"]);
  });

  it("Case 4: geometry + metallic change keeps material-values", () => {
    const prev = matScene();
    const next = matScene({
      surfaces: [...matScene().surfaces!, chip],
      materials: { silicone: { ...BASE_MATS.silicone!, metallic: 1 } },
    });
    expect(diffMaterialFrame(prev, next).reasons).toEqual(["scene", "material-values"]);
  });

  it("Case 5: geometry + ior change keeps material-values", () => {
    const prev = matScene();
    const next = matScene({
      surfaces: [...matScene().surfaces!, chip],
      materials: { silicone: { ...BASE_MATS.silicone!, ior: 2 } },
    });
    expect(diffMaterialFrame(prev, next).reasons).toEqual(["scene", "material-values"]);
  });

  it("Case 6: surfaceCount change with an UNCHANGED material table never fires material-values", () => {
    const prev = matScene();
    // chip reuses silicone; the table bytes are identical (same material
    // definition, same first-appearance order)
    const next = matScene({ surfaces: [...matScene().surfaces!, chip] });
    const diff = diffMaterialFrame(prev, next);
    expect(diff.reasons).toEqual(["scene"]);
    expect(diff.reasons).not.toContain("material-values");
  });

  it("Case 7: maskCount change + material value change keeps material-values", () => {
    const maskScene = (addMask: boolean, red: boolean): SceneInput => {
      const surfaces = matScene().surfaces!.map((s) => ({ ...s }));
      const glyph: SurfaceNode = {
        id: "glyph",
        position: { x: 40, y: 30 },
        size: { x: 12, y: 12 },
        elevation: 2,
        thickness: 2,
        shape: { kind: "mask", mask: { width: 4, height: 4, alpha: new Float32Array(16).fill(1) } },
        profile: { kind: "flat" },
        material: "silicone",
        castsShadow: true,
        receivesShadow: true,
      };
      return {
        width: 100,
        height: 80,
        surfaces: addMask ? [...surfaces, glyph] : surfaces,
        materials: { silicone: { ...BASE_MATS.silicone!, baseColor: red ? RED : GRAY } },
        light: { direction: { x: -0.6, y: -0.8, z: 1 }, intensity: 1 },
      };
    };
    const prev = maskScene(false, false);
    const next = maskScene(true, true);
    const diff = diffMaterialFrame(prev, next);
    expect(diff.reasons).toEqual(["scene", "material-values"]);
  });

  it("material-only change keeps the historical material-values reason", () => {
    const prev = matScene();
    const next = matScene({ materials: { silicone: { ...BASE_MATS.silicone!, baseColor: RED } } });
    const diff = diffMaterialFrame(prev, next);
    expect(diff.reasons).toEqual(["material-values"]);
    // the documented closure: upload + lighting + presentation only
    expect(diff.executed).toEqual(["upload", "lighting", "presentation"]);
  });
});

describe("classifySceneChange — #43 material-value direct regressions", () => {
  const GRAY = { r: 0.8, g: 0.8, b: 0.8 };
  const RED = { r: 1, g: 0.1, b: 0.1 };
  const base = (over: Partial<SceneInput> = {}): SceneInput => ({
    width: 100,
    height: 80,
    surfaces: [
      {
        id: "panel",
        position: { x: 0, y: 0 },
        size: { x: 100, y: 80 },
        elevation: 0,
        thickness: 0,
        shape: { kind: "roundedRect", radius: 0 },
        profile: { kind: "flat" },
        material: "silicone",
        castsShadow: false,
        receivesShadow: true,
      },
    ],
    materials: { silicone: { baseColor: GRAY, roughness: 0.5, metallic: 0, ior: 1.45 } },
    light: { direction: { x: -0.6, y: -0.8, z: 1 }, intensity: 1 },
    ...over,
  });
  const chip: SurfaceNode = {
    id: "chip",
    position: { x: 80, y: 60 },
    size: { x: 6, y: 6 },
    elevation: 1,
    thickness: 1,
    shape: { kind: "roundedRect", radius: 0 },
    profile: { kind: "flat" },
    material: "silicone",
    castsShadow: true,
    receivesShadow: true,
  };
  const bytes = (scene: SceneInput) => encodeScene(createScene(scene), 1).bytes;

  it("geometry-only -> ['scene']", () => {
    expect(classifySceneChange(bytes(base()), bytes(base({ surfaces: [...base().surfaces!, chip] })))).toEqual(["scene"]);
  });

  it("material-only -> ['material-values']", () => {
    expect(
      classifySceneChange(
        bytes(base()),
        bytes(base({ materials: { silicone: { ...base().materials!.silicone!, baseColor: RED } } })),
      ),
    ).toEqual(["material-values"]);
  });

  it("geometry + material -> ['scene', 'material-values']", () => {
    expect(
      classifySceneChange(
        bytes(base()),
        bytes(
          base({
            surfaces: [...base().surfaces!, chip],
            materials: { silicone: { ...base().materials!.silicone!, baseColor: RED } },
          }),
        ),
      ),
    ).toEqual(["scene", "material-values"]);
  });

  it("geometry + angularRadius + material -> ['scene', 'light-angular-radius', 'material-values']", () => {
    expect(
      classifySceneChange(
        bytes(base()),
        bytes(
          base({
            surfaces: [...base().surfaces!, chip],
            light: { direction: { x: -0.6, y: -0.8, z: 1 }, intensity: 1, angularRadius: Math.fround(0.2) },
            materials: { silicone: { ...base().materials!.silicone!, baseColor: RED } },
          }),
        ),
      ),
    ).toEqual(["scene", "light-angular-radius", "material-values"]);
  });
});

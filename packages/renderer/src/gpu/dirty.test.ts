import { describe, expect, it } from "vitest";
import { createScene } from "../scene";
import type { SceneInput } from "../scene";
import {
  ALL_STAGES,
  REASON_STAGES,
  computeFrameKey,
  computeInvalidationReasons,
  fingerprintBytes,
  reportInvalidations,
  stagesForReasons,
} from "./dirty";
import { encodeScene } from "./encode";

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

describe("#31 invalidation dependency graph — stagesForReasons / REASON_STAGES", () => {
  it("maps every reason to exactly the brief's downstream closure", () => {
    expect(REASON_STAGES["first-frame"]).toEqual(ALL_STAGES);
    expect(REASON_STAGES.viewport).toEqual(ALL_STAGES);
    expect(REASON_STAGES.scene).toEqual(ALL_STAGES);
    expect(REASON_STAGES["normal-options"]).toEqual(["normal", "lighting", "presentation"]);
    expect(REASON_STAGES["shadow-options"]).toEqual(["shadow", "lighting", "presentation"]);
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
    expect(computeInvalidationReasons(debug, prod)).toEqual(["debug-target"]);
  });
});

describe("#31 reportInvalidations", () => {
  it("invalidates everything on the first frame", () => {
    const report = reportInvalidations(key(), null, false);
    expect(report.reasons).toEqual(["first-frame"]);
    expect(report.executed).toEqual(ALL_STAGES);
    expect(report.skipped).toEqual([]);
    expect(report.retained).toBe(false);
  });

  it("reports a byte-identical repeated frame as fully retained", () => {
    const previous = key();
    const report = reportInvalidations(key(), previous, false);
    expect(report.reasons).toEqual([]);
    expect(report.executed).toEqual([]);
    expect(report.skipped).toEqual(ALL_STAGES);
    expect(report.retained).toBe(true);
  });

  it("adds only presentation for a requested retained repaint", () => {
    const previous = key();
    const report = reportInvalidations(key(), previous, true);
    expect(report.reasons).toEqual([]);
    expect(report.executed).toEqual(["presentation"]);
    expect(report.skipped).toEqual(["upload", "height", "normal", "shadow", "lighting"]);
    expect(report.retained).toBe(false);
  });

  it("propagates each option change to only its downstream closure", () => {
    const base = key();
    expect(reportInvalidations(key(1, { normal: { scaleX: 0.9 } }), base, false).executed).toEqual([
      "normal",
      "lighting",
      "presentation",
    ]);
    expect(reportInvalidations(key(1, { shadow: { bias: 0.25 } }), base, false).executed).toEqual([
      "shadow",
      "lighting",
      "presentation",
    ]);
    expect(reportInvalidations(key(1, { lighting: { ambient: 0.3 } }), base, false).executed).toEqual([
      "lighting",
      "presentation",
    ]);
    expect(
      reportInvalidations(key(1, { composite: { shadowAlpha: 0.6 } }), base, false).executed,
    ).toEqual(["presentation"]);
  });

  it("treats a stale (null) previous key as first-frame even with equal fingerprints", () => {
    expect(reportInvalidations(key(), null, false).reasons).toEqual(["first-frame"]);
  });
});

import { describe, expect, it } from "vitest";
import { grainRoughness, sanitizeGrain } from "./grain";
import { createScene } from "./scene";
import { lightScene } from "./lighting";
import { composeSdfHeightField, composeCasterHeightField } from "./geometry";
import { encodeScene, parseHeader } from "./gpu/encode";
import { sceneSectionLayout } from "./gpu/layout";
import { validateEncodedScene } from "./gpu/validate";

function scene(grain = false) {
  return createScene({ width: 24, height: 24, surfaces: [{ id: "resin", position: { x: 3, y: 3 }, size: { x: 16, y: 16 },
    elevation: 3, thickness: 2, bevelWidth: 2, shape: { kind: "roundedRect", radius: 3 },
    profile: { kind: "smooth" }, material: "resin", castsShadow: true, receivesShadow: true }],
    materials: { resin: { baseColor: { r: 0.3, g: 0.35, b: 0.4 }, roughness: 0.4, metallic: 0,
      grain: grain ? { scale: 4, strength: 0.8, seed: 19 } : undefined } } });
}
describe("surface-local resin grain", () => {
  it("is deterministic, seed-sensitive and fades subpixel variation", () => {
    const grain = sanitizeGrain({ scale: 4, seed: 42 })!;
    const a = grainRoughness(0.5, 2.5, 3.5, grain);
    expect(a).toBe(grainRoughness(0.5, 2.5, 3.5, grain));
    expect(a).not.toBe(grainRoughness(0.5, 2.5, 3.5, { ...grain, seed: 43 }));
    expect(grainRoughness(0.01, 1, 2, { ...grain, scale: 0.25 })).toBe(Math.fround(0.01));
    expect(grainRoughness(0.5, 5, 7, grain, 2)).toBe(grainRoughness(0.5, 10, 14, { ...grain, scale: 8 }, 1));
    expect(sanitizeGrain({ strength: 0 })).toBeUndefined();
    expect(sanitizeGrain({ scale: NaN, strength: Infinity, seed: NaN })).toEqual({ scale: 3, strength: Math.fround(0.3), seed: 0 });
  });
  it("changes shading while preserving geometry, ownership, normals and cast shadow", () => {
    const a = scene(), b = scene(true);
    const ca = composeSdfHeightField(a), cb = composeSdfHeightField(b);
    for (const key of ["height", "objectId"] as const) expect(cb[key].data).toEqual(ca[key].data);
    expect(composeCasterHeightField(b).data).toEqual(composeCasterHeightField(a).data);
    const la = lightScene(a), lb = lightScene(b);
    expect(lb.normal.data).toEqual(la.normal.data);
    expect(lb.visibility!.data).toEqual(la.visibility!.data);
    expect(lb.color.data).not.toEqual(la.color.data);
    expect(lightScene(b).color.data).toEqual(lb.color.data);
  });
  it("stores material-only parameters in ABI v5 and rejects v4/reserved corruption", () => {
    const encoded = encodeScene(scene(true), 1), header = parseHeader(encoded.bytes);
    const layout = sceneSectionLayout(header), view = new DataView(encoded.bytes.buffer);
    expect(header.version).toBe(5); expect(validateEncodedScene(encoded.bytes).ok).toBe(true);
    expect(view.getFloat32(layout.materialsOffset + 48, true)).toBe(4);
    expect(view.getUint32(layout.materialsOffset + 56, true)).toBe(19);
    for (const [offset, value] of [[4, 4], [layout.materialsOffset + 60, 1]]) {
      const changed = encoded.bytes.slice(); new DataView(changed.buffer).setUint32(offset, value, true);
      expect(validateEncodedScene(changed).ok).toBe(false);
    }
  });
});

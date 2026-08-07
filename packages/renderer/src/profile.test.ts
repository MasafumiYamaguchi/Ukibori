import { describe, expect, it } from "vitest";
import { evaluateProfile } from "./profile";
import type { HeightProfile } from "./scene";

describe("evaluateProfile: flat", () => {
  it("is a step at the shape boundary", () => {
    const profile: HeightProfile = { kind: "flat" };
    expect(evaluateProfile(profile, -5, 2, 3)).toBe(3);
    expect(evaluateProfile(profile, -0.001, 2, 3)).toBe(3);
    expect(evaluateProfile(profile, 0, 2, 3)).toBe(0);
    expect(evaluateProfile(profile, 5, 2, 3)).toBe(0);
    expect(evaluateProfile(profile, -5, 0, 0)).toBe(0);
  });
});

describe("evaluateProfile: bevel (inward band [-bevelWidth, 0])", () => {
  const profile: HeightProfile = { kind: "bevel" };

  it("plateaus at full thickness inside the band", () => {
    expect(evaluateProfile(profile, -100, 2, 3)).toBe(3);
    expect(evaluateProfile(profile, -2, 2, 3)).toBe(3);
  });

  it("reaches half thickness at the mid-band", () => {
    expect(evaluateProfile(profile, -1, 2, 3)).toBe(1.5);
  });

  it("is zero at the nominal boundary and outside", () => {
    expect(evaluateProfile(profile, 0, 2, 3)).toBe(0);
    expect(evaluateProfile(profile, 1, 2, 3)).toBe(0);
    expect(evaluateProfile(profile, 5, 2, 3)).toBe(0);
  });

  it("is monotone non-increasing from inside to the boundary", () => {
    const samples = [-2, -1.5, -1, -0.5, 0].map((d) =>
      evaluateProfile(profile, d, 2, 3),
    );
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]).toBeLessThanOrEqual(samples[i - 1]);
    }
  });

  it("is continuous across the band endpoints", () => {
    const eps = 1e-9;
    expect(evaluateProfile(profile, -2 - eps, 2, 3)).toBeCloseTo(evaluateProfile(profile, -2, 2, 3), 6);
    expect(evaluateProfile(profile, -2 + eps, 2, 3)).toBeCloseTo(evaluateProfile(profile, -2, 2, 3), 6);
    expect(evaluateProfile(profile, 0 - eps, 2, 3)).toBeCloseTo(0, 6);
    expect(evaluateProfile(profile, 0 + eps, 2, 3)).toBeCloseTo(0, 6);
  });

  it("returns the flat step when bevelWidth is 0", () => {
    expect(evaluateProfile(profile, -1, 0, 3)).toBe(3);
    expect(evaluateProfile(profile, 0, 0, 3)).toBe(0);
    expect(evaluateProfile(profile, 1, 0, 3)).toBe(0);
  });

  it("is finite for all finite inputs", () => {
    for (const d of [-1000, -0.3, 0, 7.7, 1000]) {
      expect(Number.isFinite(evaluateProfile(profile, d, 2, 3))).toBe(true);
    }
  });
});

describe("evaluateProfile: unknown kinds", () => {
  it("throws for unknown profile kinds (validation prevents this)", () => {
    const bad = { kind: "smoothStep" } as unknown as HeightProfile;
    expect(() => evaluateProfile(bad, 0, 2, 3)).toThrow(/not implemented/);
  });
});

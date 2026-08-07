import { describe, expect, it } from "vitest";
import { evaluateProfile } from "./profile";
import type { HeightProfile } from "./scene";

describe("evaluateProfile", () => {
  it("flat returns the constant thickness regardless of distance", () => {
    const profile: HeightProfile = { kind: "flat" };
    expect(evaluateProfile(profile, -5, 2, 3)).toBe(3);
    expect(evaluateProfile(profile, 0, 2, 3)).toBe(3);
    expect(evaluateProfile(profile, 5, 2, 3)).toBe(3);
    expect(evaluateProfile(profile, -5, 0, 0)).toBe(0);
  });

  it("throws for unknown profile kinds (validation prevents this)", () => {
    const bad = { kind: "smoothStep" } as unknown as HeightProfile;
    expect(() => evaluateProfile(bad, 0, 2, 3)).toThrow(/not implemented/);
  });
});

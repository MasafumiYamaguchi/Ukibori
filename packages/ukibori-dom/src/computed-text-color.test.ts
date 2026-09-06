import { describe, expect, it } from "vitest";
import { parseOpaqueComputedSrgb, readOpaqueComputedTextColor } from "./computed-text-color";

describe("#56 computed CSS text color", () => {
  it.each([
    ["rgb(0, 0, 0)", { r: 0, g: 0, b: 0 }],
    ["rgb(255, 255, 255)", { r: 1, g: 1, b: 1 }],
    ["rgb(255 0 0)", { r: 1, g: 0, b: 0 }],
    ["rgb(0 0 255 / 100%)", { r: 0, g: 0, b: 1 }],
  ])("converts opaque browser-normalized sRGB exactly once: %s", (css, expected) => {
    expect(parseOpaqueComputedSrgb(css)).toEqual(expected);
  });

  it("uses the standard sRGB transfer curve for gray", () => {
    const gray = parseOpaqueComputedSrgb("rgb(128, 128, 128)");
    expect(gray?.r).toBeCloseTo(0.2158605, 6);
    expect(gray?.g).toBe(gray?.r);
    expect(gray?.b).toBe(gray?.r);
  });

  it.each([
    "rgba(255, 0, 0, 0.5)",
    "rgb(255 0 0 / 99%)",
    "transparent",
    "canvastext",
    "color(display-p3 1 0 0)",
    "rgb(nope, 0, 0)",
  ])("fails closed for non-opaque or unsupported computed color: %s", (css) => {
    expect(parseOpaqueComputedSrgb(css)).toBeNull();
  });

  it("reads inherited computed color from the live element", () => {
    const parent = document.createElement("div");
    parent.style.color = "rgb(255, 0, 0)";
    const child = document.createElement("span");
    parent.appendChild(child);
    document.body.appendChild(parent);
    expect(readOpaqueComputedTextColor(child)).toEqual({ r: 1, g: 0, b: 0 });
  });
});

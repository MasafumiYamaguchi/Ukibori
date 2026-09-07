import type { LinearRgb } from "ukibori-renderer";

/**
 * Parse the browser-normalized computed `color` forms used by CSSOM.
 * Partial alpha and unrecognized color spaces fail closed so the DOM keeps
 * ownership of its ink.
 */
export function parseOpaqueComputedColor(value: string): LinearRgb | null {
  const input = value.trim().toLowerCase();
  const match = /^(rgba?)\(\s*([+-]?(?:\d+\.?\d*|\.\d+))\s*[, ]\s*([+-]?(?:\d+\.?\d*|\.\d+))\s*[, ]\s*([+-]?(?:\d+\.?\d*|\.\d+))(?:\s*[,/]\s*([+-]?(?:\d+\.?\d*|\.\d+)%?))?\s*\)$/.exec(input);
  if (match === null) {
    return null;
  }
  const alphaText = match[5];
  if (alphaText !== undefined) {
    const alpha = alphaText.endsWith("%")
      ? Number(alphaText.slice(0, -1)) / 100
      : Number(alphaText);
    if (!Number.isFinite(alpha) || alpha !== 1) {
      return null;
    }
  } else if (match[1] === "rgba") {
    return null;
  }
  const channels = [Number(match[2]), Number(match[3]), Number(match[4])];
  if (channels.some((channel) => !Number.isFinite(channel))) {
    return null;
  }
  const linear = channels.map((channel) => srgbToLinear(Math.min(255, Math.max(0, channel)) / 255));
  return { r: linear[0], g: linear[1], b: linear[2] };
}

function srgbToLinear(value: number): number {
  const result = value <= 0.04045
    ? value / 12.92
    : Math.pow((value + 0.055) / 1.055, 2.4);
  return Math.fround(result);
}

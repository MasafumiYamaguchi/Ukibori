import type { LinearRgb } from "ukibori-renderer";

/**
 * #56 computed CSS text color -> renderer albedo.
 *
 * `getComputedStyle(element).color` is the source of truth because it includes
 * inheritance, classes and CSS custom properties. Browsers serialize the
 * ordinary sRGB colors supported here as rgb()/rgba(). The renderer's
 * `Material.baseColor` is linear RGB, so conversion happens exactly once at
 * this DOM boundary. Partially transparent or unsupported computed colors
 * return null: the RGB-only renderer cannot faithfully own that ink and the
 * #52 DOM fallback must stay visible.
 */
export function readOpaqueComputedTextColor(element: HTMLElement): LinearRgb | null {
  try {
    return parseOpaqueComputedSrgb(getComputedStyle(element).color);
  } catch {
    return null;
  }
}

/** Pure parser/test seam for browser-normalized rgb()/rgba() computed values. */
export function parseOpaqueComputedSrgb(value: string): LinearRgb | null {
  const match = /^rgba?\((.*)\)$/i.exec(value.trim());
  if (match === null) {
    return null;
  }

  const body = match[1]!.trim();
  let channels: string[];
  let alphaToken: string | undefined;
  if (body.includes(",")) {
    const parts = body.split(",").map((part) => part.trim());
    if (parts.length !== 3 && parts.length !== 4) {
      return null;
    }
    channels = parts.slice(0, 3);
    alphaToken = parts[3];
  } else {
    const slash = body.split("/").map((part) => part.trim());
    if (slash.length > 2) {
      return null;
    }
    channels = slash[0]!.split(/\s+/).filter(Boolean);
    alphaToken = slash[1];
  }
  if (channels.length !== 3) {
    return null;
  }

  const srgb = channels.map(parseSrgbChannel);
  const alpha = alphaToken === undefined ? 1 : parseAlpha(alphaToken);
  if (srgb.some((channel) => channel === null) || alpha === null || alpha < 1) {
    return null;
  }
  const [r, g, b] = srgb as [number, number, number];
  return {
    r: srgbToLinear(r),
    g: srgbToLinear(g),
    b: srgbToLinear(b),
  };
}

export function linearRgbEqual(a: LinearRgb | undefined, b: LinearRgb | undefined): boolean {
  return a === b ||
    (a !== undefined && b !== undefined && a.r === b.r && a.g === b.g && a.b === b.b);
}

function parseSrgbChannel(token: string): number | null {
  const percent = token.endsWith("%");
  const number = Number(percent ? token.slice(0, -1) : token);
  if (!Number.isFinite(number)) {
    return null;
  }
  return clamp01(number / (percent ? 100 : 255));
}

function parseAlpha(token: string): number | null {
  const percent = token.endsWith("%");
  const number = Number(percent ? token.slice(0, -1) : token);
  if (!Number.isFinite(number)) {
    return null;
  }
  return clamp01(number / (percent ? 100 : 1));
}

function srgbToLinear(value: number): number {
  return value <= 0.04045
    ? value / 12.92
    : Math.pow((value + 0.055) / 1.055, 2.4);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

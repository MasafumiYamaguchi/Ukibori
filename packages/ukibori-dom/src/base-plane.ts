import type { BasePlaneOptions } from "ukibori-renderer";
import { sanitizeBasePlane } from "ukibori-renderer";
import { parseOpaqueComputedSrgb } from "./computed-text-color";
import { readPageScroll } from "./measure";
import type { Region } from "./types";

/** Explicit sRGB input only. No ancestor/background inference or CSS paint emulation. */
export function parseBasePlaneColor(value: string | undefined): BasePlaneOptions | undefined {
  if (value === undefined) return undefined;
  let css = value.trim();
  const hex = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(css);
  if (hex) {
    const digits = hex[1]!.length === 3 ? [...hex[1]!].map(c => c + c).join("") : hex[1]!;
    css = `rgb(${[0, 2, 4].map(i => parseInt(digits.slice(i, i + 2), 16)).join(",")})`;
  }
  const baseColor = parseOpaqueComputedSrgb(css);
  if (baseColor === null) throw new TypeError("basePlaneColor must be an opaque sRGB #rgb, #rrggbb, rgb() or rgba() color");
  return sanitizeBasePlane({ baseColor });
}

/** The stage's visible padding box, in document coordinates. No surface-bounds patch. */
export function measureBasePlaneRegion(stage: Element): Region | null {
  const rect = stage.getBoundingClientRect();
  const { scrollX, scrollY } = readPageScroll();
  const w = stage.clientWidth, h = stage.clientHeight;
  if (!(w > 0 && h > 0)) return null;
  return { x: rect.left + scrollX + stage.clientLeft, y: rect.top + scrollY + stage.clientTop, w, h };
}

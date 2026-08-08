import { viewportRectToDocument } from "./coords";
import type { DomSurfaceOptions, MeasuredGeometry } from "./types";

/**
 * Geometry extraction for the DOM integration layer (#20).
 *
 * The minimum per the issue: `getBoundingClientRect()` for position/size,
 * explicit Ukibori shape props for the radius, and computed style only for
 * the border-radius fallback (one value, no full CSS parsing). The result is
 * a document-space `MeasuredGeometry` in CSS pixels.
 */

/**
 * Read the element's viewport rect. Exposed for testability; jsdom returns
 * zeros unless the method is stubbed.
 */
export function readViewportRect(element: Element): DOMRect {
  return element.getBoundingClientRect();
}

/** Current page scroll offsets (guarded for non-window environments). */
export function readPageScroll(): { scrollX: number; scrollY: number } {
  const g = globalThis as { window?: { scrollX?: number; scrollY?: number } };
  const win = g.window;
  return {
    scrollX: typeof win?.scrollX === "number" ? win.scrollX : 0,
    scrollY: typeof win?.scrollY === "number" ? win.scrollY : 0,
  };
}

/**
 * Fallback corner radius from the element's computed `border-radius`.
 * Reads the top-left corner only and accepts a single length value or the
 * "a b a b" shorthand (top-left first). Non-px units / calc / percentages are
 * ignored (returns 0) — no full CSS parsing.
 */
export function readComputedBorderRadius(element: Element): number {
  if (typeof getComputedStyle !== "function") {
    return 0;
  }
  const value = getComputedStyle(element).borderTopLeftRadius;
  if (value === undefined) {
    return 0;
  }
  const first = value.trim().split(/\s+/)[0];
  if (first === undefined || !first.endsWith("px")) {
    return 0;
  }
  const px = Number.parseFloat(first);
  return Number.isFinite(px) && px >= 0 ? px : 0;
}

/**
 * Measure a registered element into document-space geometry.
 *
 * `shape` decides the radius source: an explicit `radius` wins; otherwise the
 * element's computed `border-top-left-radius` is used (mask shapes ignore the
 * radius).
 */
export function measureSurfaceElement(
  element: Element,
  options: DomSurfaceOptions,
): MeasuredGeometry {
  const rect = readViewportRect(element);
  const { scrollX, scrollY } = readPageScroll();
  const doc = viewportRectToDocument(rect, scrollX, scrollY);
  const radius =
    options.shape.kind === "roundedRect" && options.shape.radius !== undefined
      ? sanitizeRadius(options.shape.radius)
      : options.shape.kind === "roundedRect"
        ? readComputedBorderRadius(element)
        : 0;
  return {
    x: doc.x,
    y: doc.y,
    w: doc.w,
    h: doc.h,
    radius,
  };
}

function sanitizeRadius(radius: number): number {
  return Number.isFinite(radius) && radius >= 0 ? radius : 0;
}

/**
 * True when two measured geometries are close enough to skip a re-render.
 * All values are scene-unit CSS pixels; a sub-pixel epsilon avoids re-renders
 * on micro-layout jitter while still tracking real resize.
 */
export function geometriesEqual(
  a: MeasuredGeometry | null,
  b: MeasuredGeometry | null,
): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return (
    Math.abs(a.x - b.x) < 0.01 &&
    Math.abs(a.y - b.y) < 0.01 &&
    Math.abs(a.w - b.w) < 0.01 &&
    Math.abs(a.h - b.h) < 0.01 &&
    Math.abs(a.radius - b.radius) < 0.01
  );
}

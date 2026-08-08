import type { Region } from "./types";

/**
 * Coordinate helpers for the DOM integration layer (#20).
 *
 * The layer uses DOCUMENT-relative CSS pixels (see `types.ts`): element
 * geometry is read as a viewport-relative `getBoundingClientRect()` and moved
 * into document space by adding the current page scroll offsets. Keeping the
 * retained scene in document space means ordinary page scroll does not change
 * scene geometry — the overlay is positioned at the document origin and moves
 * with the page, so scroll does not force a re-render (sticky / transformed /
 * nested-scroll cases are handled by re-measuring on scroll, see dom-layer).
 */

export interface ViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Convert a viewport-relative rect into a document-space rect. */
export function viewportRectToDocument(
  rect: ViewportRect,
  scrollX: number,
  scrollY: number,
): { x: number; y: number; w: number; h: number } {
  const x = rect.left + scrollX;
  const y = rect.top + scrollY;
  const w = rect.width;
  const h = rect.height;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new TypeError(`non-finite viewport rect origin: ${rect.left}, ${rect.top}`);
  }
  return { x, y, w, h };
}

/**
 * Union of the given document-space boxes inflated by `margin` on every side.
 * Returns null when there are no valid boxes (nothing to render).
 *
 * `margin` reserves room for cast shadows that extend past the surfaces
 * themselves (#17); shadowed base-plane pixels are clipped at the region
 * boundary.
 */
export function computeRegion(
  boxes: readonly { x: number; y: number; w: number; h: number }[],
  margin: number,
): Region | null {
  const m = sanitizeMargin(margin);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const box of boxes) {
    if (!isFiniteRect(box) || box.w <= 0 || box.h <= 0) {
      continue;
    }
    if (box.x < minX) minX = box.x;
    if (box.y < minY) minY = box.y;
    if (box.x + box.w > maxX) maxX = box.x + box.w;
    if (box.y + box.h > maxY) maxY = box.y + box.h;
  }
  if (!Number.isFinite(minX)) {
    return null;
  }
  return {
    x: minX - m,
    y: minY - m,
    w: (maxX - minX) + 2 * m,
    h: (maxY - minY) + 2 * m,
  };
}

function isFiniteRect(
  box: { x: number; y: number; w: number; h: number },
): boolean {
  return (
    Number.isFinite(box.x) &&
    Number.isFinite(box.y) &&
    Number.isFinite(box.w) &&
    Number.isFinite(box.h)
  );
}

function sanitizeMargin(margin: number): number {
  return Number.isFinite(margin) && margin >= 0 ? margin : 0;
}

/**
 * Render-target texel size for a region at a given dpr, mirroring the
 * renderer's resolution contract (`floor(sceneSize * dpr)` texels).
 */
export function renderTargetSize(
  region: Region,
  dpr: number,
): { width: number; height: number } {
  const width = Math.floor(region.w * dpr);
  const height = Math.floor(region.h * dpr);
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new RangeError(
      `render target must be positive: ${width}x${height} for region ${region.w}x${region.h} at dpr ${dpr}`,
    );
  }
  return { width, height };
}

/** Sanitize a device-pixel-ratio value to a finite number >= 1. */
export function sanitizeDpr(dpr: number | undefined): number {
  return typeof dpr === "number" && Number.isFinite(dpr) && dpr >= 1 ? dpr : 1;
}

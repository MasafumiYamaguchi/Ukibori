import { renderTargetSize, sanitizeDpr } from "./coords";
import { readPageScroll } from "./measure";
import type { Region, SurfaceImage } from "./types";

/**
 * Overlay canvas (#20).
 *
 * The overlay is a single absolutely-positioned `<canvas>` inserted as the
 * FIRST CHILD of the **stage** element:
 *
 * - **Stage-root contract**: the stage is the element that contains the
 *   registered surfaces (typically their innermost shared container). The
 *   canvas is inserted inside the stage so it paints WITHIN the stage's
 *   subtree: every in-flow ancestor background (an ordinary opaque card,
 *   panel, ...) is painted before its descendants, so the canvas is always
 *   above them, and `z-index: -1` keeps it below the surfaces' own in-flow
 *   content. A document-level canvas would instead be covered by opaque
 *   ancestors, which is why the canvas must live inside the stage.
 *   The stage receives the managed `data-ukibori-stage` attribute and the
 *   injected stylesheet applies `isolation: isolate` — a stacking context
 *   with NO layout, positioning or containing-block effect — so the canvas's
 *   negative z-index is contained even when the stage is otherwise static.
 * - **Positioning**: the canvas is `position: absolute`; `left`/`top` are
 *   set in the coordinate system of its containing block (measured via the
 *   `offsetParent` chain, with a computed-style fallback walk for
 *   transform/filter ancestors), so a positioned stage or a positioned
 *   ancestor wrapper both work. No registered element or ancestor is ever
 *   given a `position` — absolutely positioned descendants keep their
 *   containing block.
 * - `pointer-events: none` — hit-testing, focus, keyboard and pointer events
 *   belong entirely to the DOM underneath; the canvas never captures them.
 * - `aria-hidden="true"`, `role="presentation"` and `tabindex="-1"`: the
 *   canvas is inert to the accessibility tree and to focus.
 *
 * The backing store is DPR-scaled (`floor(region.w * dpr)` texels) while the
 * CSS size stays in CSS pixels, so `putImageData` writes crisp device pixels.
 */

/** Managed attribute marking a registered surface (suppressed appearance). */
export const SURFACE_ATTR = "data-ukibori-surface";
/** Managed attribute marking the stage element (isolation for the overlay). */
export const STAGE_ATTR = "data-ukibori-stage";
/** Marker attribute on the injected stylesheet (deduplication). */
export const STYLE_ATTR = "data-ukibori-style";
/** Marker attribute on the overlay canvas (managed-DOM filtering). */
export const OVERLAY_ATTR = "data-ukibori-overlay";

/**
 * Ownership-safe suppression: a stylesheet rule keyed on `SURFACE_ATTR`
 * (applied by adding the attribute on register, removed on unregister). No
 * inline styles are saved or restored, so while registered, app/React inline
 * style updates cannot double-render (the rule overrides plain inline
 * values), and on unregister the element reveals its LATEST app-owned style
 * rather than a stale mount-time snapshot.
 */
export function ensureOverlayStylesheet(doc: Document = document): HTMLStyleElement {
  const existing = doc.querySelector<HTMLStyleElement>(`style[${STYLE_ATTR}]`);
  if (existing !== null) {
    return existing;
  }
  const style = doc.createElement("style");
  style.setAttribute(STYLE_ATTR, "");
  style.textContent = [
    `[${SURFACE_ATTR}] { background: transparent !important; box-shadow: none !important; }`,
    `[${STAGE_ATTR}] { isolation: isolate; }`,
  ].join("\n");
  (doc.head ?? doc.documentElement).appendChild(style);
  return style;
}

interface AttributeOwnership {
  /** live owners (UkiboriDom instances) of the attribute */
  refs: number;
  /** true when the attribute existed before the first owner acquired it */
  preexisting: boolean;
}

/**
 * Per-element ownership of a managed attribute. Reference-counted so that
 * multiple UkiboriDom instances sharing a stage or element stay consistent:
 * the attribute is added on first acquisition and removed only when the last
 * owner releases it. A PRE-EXISTING application-owned attribute is never
 * removed (the layer only owns what it created).
 */
const stageOwnership = new WeakMap<Element, AttributeOwnership>();
const surfaceOwnership = new WeakMap<Element, AttributeOwnership>();

function acquireAttribute(
  element: Element,
  attr: string,
  ownership: WeakMap<Element, AttributeOwnership>,
): void {
  const existing = ownership.get(element);
  if (existing !== undefined) {
    existing.refs++;
    return;
  }
  const preexisting = element.hasAttribute(attr);
  if (!preexisting) {
    element.setAttribute(attr, "");
  }
  ownership.set(element, { refs: 1, preexisting });
}

function releaseAttribute(
  element: Element,
  attr: string,
  ownership: WeakMap<Element, AttributeOwnership>,
): void {
  const record = ownership.get(element);
  if (record === undefined) {
    return;
  }
  record.refs--;
  if (record.refs > 0) {
    return;
  }
  ownership.delete(element);
  if (!record.preexisting) {
    element.removeAttribute(attr);
  }
}

/** Mark an element as a registered surface (suppress its own appearance). */
export function suppressSurface(element: HTMLElement): void {
  ensureOverlayStylesheet(document);
  acquireAttribute(element, SURFACE_ATTR, surfaceOwnership);
}

/** Unmark a registered surface (reveal the element's own current styles). */
export function restoreSurface(element: HTMLElement): void {
  releaseAttribute(element, SURFACE_ATTR, surfaceOwnership);
}

/** Acquire the stage attribute for an overlay canvas (refcounted). */
export function acquireStageAttribute(stage: Element): void {
  ensureOverlayStylesheet(document);
  acquireAttribute(stage, STAGE_ATTR, stageOwnership);
}

/** Release the stage attribute (removed when the last owner releases). */
export function releaseStageAttribute(stage: Element): void {
  releaseAttribute(stage, STAGE_ATTR, stageOwnership);
}

/**
 * True when a mutation record concerns DOM owned by the Ukibori layer: the
 * overlay canvas (any instance), the injected stylesheet, or any
 * `data-ukibori-*` attribute. The document-level MutationObserver ignores
 * these so the layer's own render output (canvas resize, suppression
 * attributes) cannot feed back into another render — external DOM mutations
 * still invalidate.
 */
export function isManagedMutation(
  mutation: MutationRecord,
  overlayNode: Element | null,
): boolean {
  if (mutation.type === "attributes" && mutation.attributeName !== null) {
    if (mutation.attributeName.startsWith("data-ukibori-")) {
      return true;
    }
  }
  const target = mutation.target;
  if (!(target instanceof Element)) {
    if (overlayNode !== null) {
      let parent = target.parentElement;
      while (parent !== null) {
        if (parent === overlayNode) {
          return true;
        }
        parent = parent.parentElement;
      }
    }
    return false;
  }
  if (target.getAttribute(OVERLAY_ATTR) !== null || target.getAttribute(STYLE_ATTR) !== null) {
    return true;
  }
  if (overlayNode !== null && (target === overlayNode || overlayNode.contains(target))) {
    return true;
  }
  return false;
}

export interface Overlay {
  /** The DOM node the overlay owns (canvas), for managed-mutation filtering. */
  readonly node?: Element;
  /** Resize + reposition the canvas to cover `region` at `dpr`. */
  resizeAndPosition(region: Region, dpr: number): void;
  /** Draw a full-scene image (1 texel = 1 canvas device pixel). */
  paint(image: SurfaceImage): void;
  /** Make the canvas fully transparent (nothing to render). */
  clear(): void;
  dispose(): void;
}

export const OVERLAY_STYLE_PROPS = {
  position: "absolute",
  zIndex: "-1",
  pointerEvents: "none",
} as const;

export class OverlayCanvas implements Overlay {
  readonly canvas: HTMLCanvasElement;
  readonly node: Element;
  readonly stage: Element;

  constructor(stage: Element = document.body, zIndex = -1) {
    ensureOverlayStylesheet(document);
    const canvas = document.createElement("canvas");
    canvas.style.position = OVERLAY_STYLE_PROPS.position;
    canvas.style.zIndex = String(zIndex);
    canvas.style.pointerEvents = OVERLAY_STYLE_PROPS.pointerEvents;
    canvas.style.left = "0px";
    canvas.style.top = "0px";
    canvas.style.width = "0px";
    canvas.style.height = "0px";
    canvas.setAttribute("aria-hidden", "true");
    canvas.setAttribute("role", "presentation");
    canvas.tabIndex = -1;
    canvas.setAttribute(OVERLAY_ATTR, "");
    this.canvas = canvas;
    this.node = canvas;
    this.stage = stage;
    acquireStageAttribute(stage);
    stage.insertBefore(canvas, stage.firstChild);
  }

  resizeAndPosition(region: Region, dpr: number): void {
    const { width, height } = renderTargetSize(region, sanitizeDpr(dpr));
    this.canvas.width = width;
    this.canvas.height = height;
    const origin = containingBlockOrigin(this.canvas);
    this.canvas.style.left = `${region.x - origin.x}px`;
    this.canvas.style.top = `${region.y - origin.y}px`;
    this.canvas.style.width = `${region.w}px`;
    this.canvas.style.height = `${region.h}px`;
  }

  paint(image: SurfaceImage): void {
    const ctx = this.canvas.getContext("2d");
    if (ctx === null) {
      return;
    }
    const img = new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
    ctx.putImageData(img, 0, 0);
  }

  clear(): void {
    const ctx = this.canvas.getContext("2d");
    if (ctx === null) {
      return;
    }
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  dispose(): void {
    this.canvas.remove();
    releaseStageAttribute(this.stage);
  }
}

/**
 * Document-space origin of the canvas's containing block (the box its
 * `left`/`top` are relative to). `offsetParent` is the browser's answer
 * (null = the initial containing block at the document origin); jsdom does
 * not implement it, and transformed/filtered ancestors are not always
 * reported, so a computed-style walk backstops it.
 *
 * A SCROLLED containing block shifts its content (including the absolutely
 * positioned canvas) by `scrollLeft`/`scrollTop`, so those offsets are
 * subtracted here: with them, the canvas's visual position equals the
 * region's document position even when the containing block itself is
 * scrolled (`overflow: auto` / `scroll`).
 */
function containingBlockOrigin(canvas: HTMLCanvasElement): { x: number; y: number } {
  let block: Element | null = null;
  const offsetParent = (canvas as unknown as { offsetParent?: Element | null }).offsetParent;
  if (offsetParent !== null && offsetParent !== undefined) {
    block = offsetParent;
  } else {
    let current = canvas.parentElement;
    while (current !== null && current !== document.documentElement) {
      const cs = getComputedStyle(current);
      if (
        cs.position !== "static" ||
        cs.transform !== "none" ||
        cs.filter !== "none" ||
        cs.backdropFilter !== "none" ||
        cs.willChange === "transform"
      ) {
        block = current;
        break;
      }
      current = current.parentElement;
    }
  }
  if (block === null) {
    return { x: 0, y: 0 };
  }
  const rect = block.getBoundingClientRect();
  const { scrollX, scrollY } = readPageScroll();
  const cs = getComputedStyle(block);
  const borderX = parseFloat(cs.borderLeftWidth) || 0;
  const borderY = parseFloat(cs.borderTopWidth) || 0;
  const scrolled = block as HTMLElement;
  const scrollLeft = typeof scrolled.scrollLeft === "number" ? scrolled.scrollLeft : 0;
  const scrollTop = typeof scrolled.scrollTop === "number" ? scrolled.scrollTop : 0;
  return {
    x: rect.left + scrollX + borderX - scrollLeft,
    y: rect.top + scrollY + borderY - scrollTop,
  };
}

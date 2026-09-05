import { forwardRef, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { MaskSource } from "ukibori-renderer";
import { Surface, mergeRefs } from "./Surface";
import type { UkiboriTextProps } from "../types";

/**
 * <UkiboriText> — DOM-owned accessible text whose GLYPH participates in the
 * physical scene through the #19 mask geometry path.
 *
 * The component renders a real `<span>` with the text: the text is always
 * DOM-owned, accessible and selectable. After mount (client only) the text
 * is rasterized into an alpha MaskSource (canvas 2d — rasterization stays
 * OUTSIDE the renderer core) and the surface registers with that mask
 * shape, so the glyph becomes physical geometry (height relief + cast
 * shadows, renderer #19).
 *
 * #52 glyph compositing contract: the DOM text ink is delegated to the
 * physical glyph ONLY while the current raster is a FAITHFUL visual
 * representation of the current DOM text:
 *
 * - the raster state is bound to its input identity (`text` + `font` prop):
 *   the moment the props change, the previous raster stops being the visual
 *   representation (render-time identity gate — a stale glyph can never
 *   suppress the DOM ink of different text);
 * - the rasterization must report `canDelegateInk` (live single-line layout
 *   metrics available, alphabetic anchoring applied, raster typography equal
 *   to the DOM typography); a multi-line/wrapped text, missing font metrics
 *   or an explicit raster font that does not match the computed DOM font
 *   keeps the DOM ink visible (the mask may stay as physical geometry, but
 *   it is never the visual source of truth);
 * - a rasterization FAILURE for the current value drops the raster entirely
 *   (plain DOM text fallback — no stale previous glyph, the physical-ink
 *   delegation is released, and a later success re-registers).
 *
 * Sizing policy (valid in bare usage, no demo CSS required): the element's
 * measured box is rounded to integer pixel dimensions, the glyph is
 * rasterized at exactly those dimensions, and the span's box is then fixed
 * to them via an explicit layout policy (`display: inline-block` by default
 * so `width`/`height` actually apply in real browser layout). The mask
 * aspect therefore equals the span's box aspect EXACTLY — the #19 isotropic
 * mapping contract holds even for fractional initial text dimensions (the
 * rounding is the policy). The INTEGER mask dimensions are authoritative for
 * the final footprint: a user-supplied `width`/`height` may influence the
 * INITIAL measurement, but the final DOM box always equals the mask
 * dimensions, so the aspects can never diverge.
 *
 * Before an identity-matched raster exists — or if rasterization failed —
 * the component stays PLAIN DOM TEXT: `shape` is `null`, nothing is
 * registered, and no rounded-rectangle substitute is created.
 * Re-rasterization happens on text/font changes and after
 * `document.fonts.ready`.
 */

/** Rasterization outcome bound to the exact input identity it was made from. */
interface RasterState {
  text: string;
  font: string | undefined;
  mask: MaskSource;
  /**
   * #52 fidelity gate: the raster is a faithful single-line visual
   * representation of the DOM text (live layout anchored, typography
   * matched) and may take over the DOM ink as the physical glyph.
   */
  canDelegateInk: boolean;
}

export const UkiboriText = forwardRef<HTMLElement, UkiboriTextProps>(
  function UkiboriText({ text, font, ...surfaceProps }, forwardedRef) {
    const innerRef = useRef<HTMLElement | null>(null);
    const [raster, setRaster] = useState<RasterState | null>(null);

    useEffect(() => {
      const element = innerRef.current;
      if (element === null || !element.isConnected) {
        return;
      }
      let cancelled = false;
      const rasterize = () => {
        if (cancelled || !element.isConnected) {
          return;
        }
        try {
          const result = rasterizeText(text, element, font);
          setRaster({ text, font, mask: result.mask, canDelegateInk: result.canDelegateInk });
        } catch (error) {
          // Rasterization failure for the CURRENT value: drop the raster
          // entirely (including any previous successful raster — it must
          // never keep representing different text). The DOM text remains
          // visible, readable and selectable as the immediate fallback.
          setRaster(null);
          console.error("UkiboriText rasterization failed:", error);
        }
      };
      rasterize();
      if (typeof document !== "undefined" && document.fonts !== undefined) {
        document.fonts.ready.then(rasterize).catch(() => undefined);
      }
      return () => {
        cancelled = true;
      };
    }, [text, font]);

    // Render-time identity gate: only an identity-matched raster represents
    // the current text/font. Everything else (props changed since the last
    // raster, failed rasterization, fidelity-degraded raster) is the plain
    // DOM fallback — the physical glyph cannot outlive its own input.
    const rasterMatches = raster !== null && raster.text === text && raster.font === font;
    // The physical geometry exists whenever an identity-matched raster
    // exists (even a fidelity-degraded one stays valid GEOMETRY); the
    // visual representation authority (DOM ink delegation) additionally
    // requires the fidelity gate.
    const shape: UkiboriTextProps["shape"] =
      rasterMatches ? { kind: "mask", mask: raster.mask } : null;
    const delegateTextInk = rasterMatches && raster.canDelegateInk;

    // Layout policy: the span must honor width/height (inline-block default;
    // a user `display` that does not honor width/height breaks the contract),
    // and the INTEGER mask dimensions are authoritative for the physical
    // footprint — the final DOM box always equals the mask dimensions. The
    // box is fixed only while an identity-matched raster exists.
    const fixedStyle: CSSProperties | undefined =
      rasterMatches
        ? {
            ...surfaceProps.style,
            display: surfaceProps.style?.display ?? "inline-block",
            width: raster.mask.width,
            height: raster.mask.height,
          }
        : surfaceProps.style;

    return (
      <Surface
        {...surfaceProps}
        as="span"
        ref={mergeRefs(forwardedRef, innerRef)}
        style={fixedStyle}
        shape={shape}
        // #52 glyph compositing contract: this component rasterizes ITS OWN
        // DOM text into the mask, and only a faithful single-line raster
        // with matching typography may take the ink over. Generic mask
        // surfaces never set this and keep their DOM text.
        delegateTextInk={delegateTextInk}
      >
        {text}
      </Surface>
    );
  },
);

/** Sizing policy: round the measured box to integer pixels. */
interface RasterizeResult {
  mask: MaskSource;
  /**
   * #52 fidelity gate result: true only when the raster anchors the live
   * DOM layout faithfully — exactly one rendered line box, the required
   * font metrics available, and (when an explicit raster font is given)
   * typography identical to the element's computed font.
   */
  canDelegateInk: boolean;
}

function rasterizeText(
  text: string,
  element: HTMLElement,
  font: string | undefined,
): RasterizeResult {
  const rect = element.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    throw new Error("canvas 2d unavailable");
  }
  ctx.clearRect(0, 0, width, height);
  ctx.font = font ?? getComputedStyle(element).font;

  // #52 alignment policy: the rasterized ink must land exactly on the DOM
  // text ink, because the physical glyph becomes the visual representation
  // once the DOM ink is delegated (#52 compositing policy) — a mismatch
  // would show as a glyph position jump across the mask-ready transition.
  //
  // The DOM ink position is measured from the LIVE layout: a Range over the
  // text gives the text's line box (its top/height include the CSS
  // line-height half-leading), and the baseline sits at
  //
  //     lineBoxTop + (lineBoxHeight - (ascent + descent)) / 2 + ascent
  //
  // with the canvas TextMetrics font bounding ascent/descent (the same font
  // metrics CSS line layout resolves). The text is drawn with an ALPHABETIC
  // baseline left-anchored at the line box origin — the same anchor the DOM
  // inline layout uses — so no magic pixel offsets, no DPR-dependent
  // correction and no font-specific constants are involved. Computed
  // letter-spacing is replicated through the canvas property when available.
  //
  // Delegation fidelity (#52): the ink is delegated ONLY when this live
  // anchoring actually happened — exactly ONE rendered line box (wrapped or
  // multi-line text cannot be faithfully rasterized by the single fillText)
  // and usable font metrics. Without them the raster falls back to the
  // legacy centered placement and remains physical GEOMETRY only: the DOM
  // ink stays visible and is never suppressed for an unfaithful mask.
  // An explicit `font` prop is allowed to delegate only when its resolved
  // (normalized) typography equals the element's computed font — a
  // typographic mismatch would make the physical glyph an inaccurate
  // representation of the DOM text.
  let anchored = false;
  let canDelegateInk = false;
  try {
    const range = document.createRange();
    range.selectNodeContents(element);
    const lineRects = range.getClientRects();
    const metrics = ctx.measureText(text);
    const ascent = metrics?.fontBoundingBoxAscent;
    const descent = metrics?.fontBoundingBoxDescent;
    const lineBox = lineRects.length === 1 ? lineRects[0] : undefined;
    if (
      lineBox !== undefined &&
      typeof ascent === "number" &&
      Number.isFinite(ascent) &&
      typeof descent === "number" &&
      Number.isFinite(descent) &&
      ascent + descent > 0
    ) {
      // Typography gate for an explicit raster font (the default path draws
      // with the element's own computed font, which matches by
      // construction).
      let typographyMatch = true;
      if (font !== undefined) {
        const computedFont = getComputedStyle(element).font;
        typographyMatch =
          computedFont.length > 0 && normalizeFont(ctx.font) === normalizeFont(computedFont);
      }
      if (typographyMatch) {
        const halfLeading = (lineBox.height - (ascent + descent)) / 2;
        const baselineY = lineBox.top - rect.top + halfLeading + ascent;
        const anchorX = lineBox.left - rect.left;
        if ("letterSpacing" in ctx) {
          const letterSpacing = getComputedStyle(element).letterSpacing;
          if (typeof letterSpacing === "string" && letterSpacing !== "normal" && letterSpacing.length > 0) {
            ctx.letterSpacing = letterSpacing;
          }
        }
        ctx.textAlign = "left";
        ctx.textBaseline = "alphabetic";
        ctx.fillStyle = "#fff";
        ctx.fillText(text, anchorX, baselineY);
        anchored = true;
        canDelegateInk = true;
      }
    }
  } catch {
    // fall through to the legacy placement (delegation stays off)
  }
  if (!anchored) {
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#fff";
    ctx.fillText(text, width / 2, height / 2);
  }
  const data = ctx.getImageData(0, 0, width, height).data;
  const alpha = new Float32Array(width * height);
  for (let i = 0; i < alpha.length; i++) {
    alpha[i] = data[i * 4 + 3] / 255;
  }
  return { mask: { width, height, alpha }, canDelegateInk };
}

/** Whitespace-insensitive font-string comparison for the typography gate. */
function normalizeFont(font: string): string {
  return font.replace(/\s+/g, " ").trim().toLowerCase();
}

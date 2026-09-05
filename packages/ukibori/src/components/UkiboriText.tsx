import { forwardRef, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { MaskSource } from "ukibori-renderer";
import { Surface, mergeRefs } from "./Surface";
import type { UkiboriTextProps } from "../types";

/**
 * <UkiboriText> — DOM-owned accessible text whose GLYPH participates in the
 * physical scene through the #19 mask geometry path.
 *
 * The component renders a real `<span>` with the text: the visible text is
 * always DOM-owned, accessible and selectable. After mount (client only) the
 * text is rasterized into an alpha MaskSource (canvas 2d — rasterization
 * stays OUTSIDE the renderer core) and the surface registers with that mask
 * shape, so the glyph becomes physical geometry (height relief + cast
 * shadows, renderer #19) while the DOM text stays the readable layer above
 * it.
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
 * Before a valid mask exists — or if rasterization fails — the component
 * stays PLAIN DOM TEXT: `shape` is `null`, nothing is registered, and no
 * rounded-rectangle substitute is created. Re-rasterization happens on
 * text/font changes and after `document.fonts.ready`.
 */

export const UkiboriText = forwardRef<HTMLElement, UkiboriTextProps>(
  function UkiboriText({ text, font, ...surfaceProps }, forwardedRef) {
    const innerRef = useRef<HTMLElement | null>(null);
    const [mask, setMask] = useState<MaskSource | null>(null);

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
          setMask(rasterizeText(text, element, font));
        } catch (error) {
          // Rasterization failure: the DOM text remains visible and readable;
          // only the physical glyph relief is lost (no substitute is made).
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

    // Layout policy: the span must honor width/height (inline-block default;
    // a user `display` that does not honor width/height breaks the contract),
    // and the INTEGER mask dimensions are authoritative for the physical
    // footprint — the final DOM box always equals the mask dimensions.
    const fixedStyle: CSSProperties | undefined =
      mask !== null
        ? {
            ...surfaceProps.style,
            display: surfaceProps.style?.display ?? "inline-block",
            width: mask.width,
            height: mask.height,
          }
        : surfaceProps.style;

    return (
      <Surface
        {...surfaceProps}
        as="span"
        ref={mergeRefs(forwardedRef, innerRef)}
        style={fixedStyle}
        shape={mask !== null ? { kind: "mask", mask } : null}
        // #52 glyph compositing contract: this component rasterizes ITS OWN
        // DOM text into the mask, so when the physical glyph is the visual
        // representation the DOM ink is delegated to it. Generic mask
        // surfaces never set this and keep their DOM text.
        delegateTextInk={mask !== null}
      >
        {text}
      </Surface>
    );
  },
);

/** Sizing policy: round the measured box to integer pixels. */
function rasterizeText(
  text: string,
  element: HTMLElement,
  font: string | undefined,
): MaskSource {
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
  // When live layout metrics are unavailable (e.g. test environments without
  // layout or canvas metrics), the rasterization falls back to the legacy
  // centered/middle placement.
  let anchored = false;
  try {
    const range = document.createRange();
    range.selectNodeContents(element);
    const lineBox = range.getClientRects()[0];
    const metrics = ctx.measureText(text);
    const ascent = metrics?.fontBoundingBoxAscent;
    const descent = metrics?.fontBoundingBoxDescent;
    if (
      lineBox !== undefined &&
      typeof ascent === "number" &&
      Number.isFinite(ascent) &&
      typeof descent === "number" &&
      Number.isFinite(descent) &&
      ascent + descent > 0
    ) {
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
    }
  } catch {
    // fall through to the legacy placement
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
  return { width, height, alpha };
}

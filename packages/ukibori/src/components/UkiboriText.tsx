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
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#fff";
  ctx.fillText(text, width / 2, height / 2);
  const data = ctx.getImageData(0, 0, width, height).data;
  const alpha = new Float32Array(width * height);
  for (let i = 0; i < alpha.length; i++) {
    alpha[i] = data[i * 4 + 3] / 255;
  }
  return { width, height, alpha };
}

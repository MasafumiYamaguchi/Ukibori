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
 * stays OUTSIDE the renderer core) at the element's size, and the surface
 * registers with that mask shape, so the glyph becomes physical geometry
 * (height relief + cast shadows, renderer #19) while the DOM text stays the
 * readable layer above it.
 *
 * The span's box is fixed to the rasterized pixel dimensions so the mask
 * mapping is exactly isotropic (#19 mapping contract). Re-rasterization
 * happens on text/font changes and after `document.fonts.ready`.
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
          // only the physical glyph relief is lost.
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

    // Fix the span's box to the rasterized pixel size so the mask mapping is
    // isotropic; the user's own width/height win when provided.
    const fixedStyle: CSSProperties | undefined =
      mask !== null && surfaceProps.style?.width === undefined && surfaceProps.style?.height === undefined
        ? { ...surfaceProps.style, width: mask.width, height: mask.height }
        : surfaceProps.style;

    return (
      <Surface
        {...surfaceProps}
        as="span"
        ref={mergeRefs(forwardedRef, innerRef)}
        style={fixedStyle}
        shape={mask !== null ? { kind: "mask", mask } : { kind: "roundedRect" }}
      >
        {text}
      </Surface>
    );
  },
);

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

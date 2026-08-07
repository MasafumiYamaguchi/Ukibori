import { createElement, forwardRef } from "react";
import type { CSSProperties } from "react";
import type { SurfaceProps } from "../types";

export const Surface = forwardRef<HTMLElement, SurfaceProps>(function Surface(
  { as = "div", className, style, material, variant, elevation, radius, ...rest },
  ref,
) {
  void material;
  void variant;
  void elevation;
  void radius;

  const mergedStyle: CSSProperties = { ...style };

  return createElement(as, { ...rest, ref, className, style: mergedStyle });
});

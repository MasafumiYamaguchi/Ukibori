import { createElement, forwardRef, useContext } from "react";
import type { CSSProperties, ElementType, ReactNode } from "react";
import { UkiboriContext } from "../context";
import { ELEVATION_MAX, RADIUS_MAX, getShadowSpec } from "../core/shadow";
import { sanitizeNumber } from "../core/math";
import type { MaterialName, PolymorphicSurfaceProps, Variant } from "../types";

export const ELEVATION_DEFAULT = 4;
export const RADIUS_DEFAULT = 12;

interface SurfaceInnerProps {
  as?: ElementType;
  className?: string;
  style?: CSSProperties;
  material?: MaterialName;
  variant?: Variant;
  elevation?: number;
  radius?: number;
}

export type SurfaceType = <C extends ElementType = "div">(
  props: PolymorphicSurfaceProps<C>,
) => ReactNode;

/**
 * Renders a raised/inset surface using the shared light from <Ukibori>.
 *
 * Style composition rule (documented in README):
 * internal style (CSS custom properties, borderRadius, boxShadow) is spread
 * first, then the user `style` — user wins on conflicts. The two shadow
 * colors are exposed as `var(--ukibori-shadow-color, ...)` /
 * `var(--ukibori-highlight-color, ...)` so they can be overridden without
 * replacing the whole box-shadow string. `className` is never lost.
 */
export const Surface = forwardRef<HTMLElement, SurfaceInnerProps>(function Surface(
  { as = "div", className, style, material = "silicone", variant = "raised", elevation = ELEVATION_DEFAULT, radius = RADIUS_DEFAULT, ...rest },
  ref,
) {
  const { light, intensity } = useContext(UkiboriContext);

  const safeElevation = sanitizeNumber(elevation, ELEVATION_DEFAULT, 0, ELEVATION_MAX);
  const safeRadius = sanitizeNumber(radius, RADIUS_DEFAULT, 0, RADIUS_MAX);
  const spec = getShadowSpec({ light, elevation: safeElevation, intensity, variant });

  const insetKeyword = variant === "inset" ? "inset " : "";
  const boxShadow = `${insetKeyword}${spec.shadowDx}px ${spec.shadowDy}px ${spec.shadowBlur}px ${spec.shadowSpread}px var(--ukibori-shadow-color, rgba(0, 0, 0, ${spec.shadowAlpha})), ${insetKeyword}${spec.highlightDx}px ${spec.highlightDy}px ${spec.highlightBlur}px 0 var(--ukibori-highlight-color, rgba(255, 255, 255, ${spec.highlightAlpha}))`;

  const internalStyle: CSSProperties = {
    "--ukibori-variant": variant,
    "--ukibori-material": material,
    "--ukibori-elevation": `${safeElevation}px`,
    "--ukibori-radius": `${safeRadius}px`,
    borderRadius: `${safeRadius}px`,
    boxShadow,
  } as CSSProperties;

  const mergedStyle = { ...internalStyle, ...style };

  return createElement(as, { ...rest, ref, className, style: mergedStyle });
}) as unknown as SurfaceType;

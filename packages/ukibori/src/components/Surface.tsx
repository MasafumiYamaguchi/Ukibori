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
 * internal style (CSS custom properties, borderRadius, backgroundColor,
 * boxShadow) is spread first, then the user `style` — user wins on
 * conflicts. Every computed value (color, radius, shadow x/y/blur/spread,
 * alphas) is exposed as a `--ukibori-*` custom property and the concrete
 * properties (borderRadius, backgroundColor, boxShadow) reference them via
 * `var()`. Overriding a custom property in the user style therefore changes
 * the actual rendered output without touching the concrete properties.
 * The user can still fully replace backgroundColor / boxShadow / etc.
 * `className` is never lost.
 */
export const Surface = forwardRef<HTMLElement, SurfaceInnerProps>(function Surface(
  { as = "div", className, style, material = "silicone", variant = "raised", elevation = ELEVATION_DEFAULT, radius = RADIUS_DEFAULT, ...rest },
  ref,
) {
  const { light, intensity, color } = useContext(UkiboriContext);

  // Unknown variants are normalized to "raised" consistently for the spec,
  // the box-shadow keyword and the --ukibori-variant variable.
  const normalizedVariant: Variant = variant === "inset" ? "inset" : "raised";

  const safeElevation = sanitizeNumber(elevation, ELEVATION_DEFAULT, 0, ELEVATION_MAX);
  const safeRadius = sanitizeNumber(radius, RADIUS_DEFAULT, 0, RADIUS_MAX);
  const spec = getShadowSpec({ light, elevation: safeElevation, intensity, variant: normalizedVariant });

  const insetKeyword = normalizedVariant === "inset" ? "inset " : "";

  const internalStyle: CSSProperties = {
    "--ukibori-variant": normalizedVariant,
    "--ukibori-material": material,
    "--ukibori-elevation": `${safeElevation}px`,
    "--ukibori-radius": `${safeRadius}px`,
    "--ukibori-color": color,
    "--ukibori-shadow-x": `${spec.shadowDx}px`,
    "--ukibori-shadow-y": `${spec.shadowDy}px`,
    "--ukibori-shadow-blur": `${spec.shadowBlur}px`,
    "--ukibori-shadow-spread": `${spec.shadowSpread}px`,
    "--ukibori-shadow-alpha": `${spec.shadowAlpha}`,
    "--ukibori-highlight-x": `${spec.highlightDx}px`,
    "--ukibori-highlight-y": `${spec.highlightDy}px`,
    "--ukibori-highlight-blur": `${spec.highlightBlur}px`,
    "--ukibori-highlight-alpha": `${spec.highlightAlpha}`,
    backgroundColor: "var(--ukibori-color)",
    borderRadius: "var(--ukibori-radius)",
    boxShadow:
      `${insetKeyword}var(--ukibori-shadow-x) var(--ukibori-shadow-y) var(--ukibori-shadow-blur) var(--ukibori-shadow-spread) var(--ukibori-shadow-color, rgba(0, 0, 0, var(--ukibori-shadow-alpha))), ` +
      `${insetKeyword}var(--ukibori-highlight-x) var(--ukibori-highlight-y) var(--ukibori-highlight-blur) 0 var(--ukibori-highlight-color, rgba(255, 255, 255, var(--ukibori-highlight-alpha)))`,
  } as CSSProperties;

  const mergedStyle = { ...internalStyle, ...style };

  return createElement(as, { ...rest, ref, className, style: mergedStyle });
}) as unknown as SurfaceType;

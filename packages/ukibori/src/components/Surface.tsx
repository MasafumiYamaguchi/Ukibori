import { createElement, forwardRef, useContext } from "react";
import type { CSSProperties, ElementType, ReactNode } from "react";
import { UkiboriContext } from "../context";
import { ELEVATION_MAX, RADIUS_MAX, getShadowSpec } from "../core/shadow";
import { applyMaterialScales, normalizeMaterialName, resolveMaterialTokens } from "../core/materials";
import type { MaterialTokensOverride } from "../core/materials";
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
  materialOverrides?: MaterialTokensOverride;
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
 *
 * Material handling: unknown material names normalize to silicone, and
 * `materialOverrides` lets users override individual tokens type-safely
 * (runtime values are sanitized). Materials with a fixed `surfaceColor`
 * (e.g. glass's translucent white) always paint that background — the
 * readable background does not depend on backdrop-filter or color-mix
 * support. Materials with `surfaceColor: null` use `var(--ukibori-color)`.
 */
export const Surface = forwardRef<HTMLElement, SurfaceInnerProps>(function Surface(
  { as = "div", className, style, material = "silicone", variant = "raised", elevation = ELEVATION_DEFAULT, radius = RADIUS_DEFAULT, materialOverrides, ...rest },
  ref,
) {
  const { light, intensity, color } = useContext(UkiboriContext);

  const normalizedVariant: Variant = variant === "inset" ? "inset" : "raised";
  const normalizedMaterial = normalizeMaterialName(material);
  const tokens = resolveMaterialTokens(normalizedMaterial, materialOverrides);

  const safeElevation = sanitizeNumber(elevation, ELEVATION_DEFAULT, 0, ELEVATION_MAX);
  const safeRadius = sanitizeNumber(radius, RADIUS_DEFAULT, 0, RADIUS_MAX);
  const spec = getShadowSpec({ light, elevation: safeElevation, intensity, variant: normalizedVariant });
  const scaled = applyMaterialScales(spec, tokens);

  const insetKeyword = normalizedVariant === "inset" ? "inset " : "";

  const internalStyle: CSSProperties = {
    "--ukibori-variant": normalizedVariant,
    "--ukibori-material": normalizedMaterial,
    "--ukibori-elevation": `${safeElevation}px`,
    "--ukibori-radius": `${safeRadius}px`,
    "--ukibori-color": color,
    "--ukibori-shadow-x": `${scaled.shadowDx}px`,
    "--ukibori-shadow-y": `${scaled.shadowDy}px`,
    "--ukibori-shadow-blur": `${scaled.shadowBlur}px`,
    "--ukibori-shadow-spread": `${scaled.shadowSpread}px`,
    "--ukibori-shadow-alpha": `${scaled.shadowAlpha}`,
    "--ukibori-highlight-x": `${scaled.highlightDx}px`,
    "--ukibori-highlight-y": `${scaled.highlightDy}px`,
    "--ukibori-highlight-blur": `${scaled.highlightBlur}px`,
    "--ukibori-highlight-alpha": `${scaled.highlightAlpha}`,
    backgroundColor: tokens.surfaceColor ?? "var(--ukibori-color)",
    borderRadius: "var(--ukibori-radius)",
    boxShadow:
      `${insetKeyword}var(--ukibori-shadow-x) var(--ukibori-shadow-y) var(--ukibori-shadow-blur) var(--ukibori-shadow-spread) var(--ukibori-shadow-color, rgba(0, 0, 0, var(--ukibori-shadow-alpha))), ` +
      `${insetKeyword}var(--ukibori-highlight-x) var(--ukibori-highlight-y) var(--ukibori-highlight-blur) 0 var(--ukibori-highlight-color, rgba(255, 255, 255, var(--ukibori-highlight-alpha)))`,
    ...(tokens.borderWidth > 0 && tokens.borderColor
      ? {
          borderWidth: tokens.borderWidth,
          borderStyle: "solid",
          borderColor: tokens.borderColor,
        }
      : {}),
    ...(tokens.backgroundImage ? { backgroundImage: tokens.backgroundImage } : {}),
    ...(tokens.backdropFilter ? { backdropFilter: tokens.backdropFilter } : {}),
  } as CSSProperties;

  const mergedStyle = { ...internalStyle, ...style };

  return createElement(as, { ...rest, ref, className, style: mergedStyle });
}) as unknown as SurfaceType;

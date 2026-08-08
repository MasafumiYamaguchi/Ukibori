import { createElement, forwardRef, useContext, useEffect, useId, useMemo, useRef } from "react";
import type { CSSProperties, ElementType, MutableRefObject, ReactNode, Ref } from "react";
import type { DomSurfaceOptions, UkiboriDom } from "ukibori-dom";
import type { HeightProfile, MaskSource } from "ukibori-renderer";
import { UkiboriContext } from "../context";
import {
  ELEVATION_MAX,
  RADIUS_MAX,
  getShadowSpec,
} from "../core/shadow";
import { applyMaterialScales, normalizeMaterialName, resolveMaterialTokens } from "../core/materials";
import type { MaterialTokensOverride } from "../core/materials";
import { sanitizeNumber } from "../core/math";
import type { MaterialName, PolymorphicSurfaceProps, Variant } from "../types";

export const ELEVATION_DEFAULT = 4;
export const RADIUS_DEFAULT = 12;

/**
 * <Surface> — a real semantic DOM element enhanced with the physical layer
 * (#21).
 *
 * The rendered element IS the caller's element (`as` is honored: buttons stay
 * buttons). All DOM props, events, focus, ARIA, form behavior, children and
 * refs are forwarded untouched. Enhancement happens AFTER hydration/effects:
 *
 * - mode "physical": the element is registered into the provider's single
 *   `UkiboriDom` retained scene (`id` is stable for the mounted lifetime).
 *   Prop updates go through the retained `updateSurface` path — never an
 *   unregister/register — so scene insertion/paint order is stable.
 * - mode "css" (`backend="css"`): the element gets the box-shadow CSS
 *   approximation — an EXPLICITLY LABELED fallback, not physical rendering.
 * - mode "none" (SSR / provider-less / before enhancement): plain semantic
 *   DOM with no styling from this package.
 *
 * CSS-approximation props (`variant`, `radius`, `materialOverrides`) apply
 * only in css mode; the physical path uses `shape`/`elevation`/`thickness`/
 * `bevelWidth`/`profile`/`material` (renderer refs).
 */

interface SurfaceInnerProps {
  as?: ElementType;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
  sceneId?: string;
  shape?: DomSurfaceOptions["shape"] | null;
  elevation?: number;
  thickness?: number;
  bevelWidth?: number;
  profile?: DomSurfaceOptions["profile"];
  material?: string;
  castsShadow?: boolean;
  receivesShadow?: boolean;
  variant?: Variant;
  radius?: number;
  materialOverrides?: MaterialTokensOverride;
}

export type SurfaceType = <C extends ElementType = "div">(
  props: PolymorphicSurfaceProps<C>,
) => ReactNode;

interface PhysicalSurfaceOptions {
  id: string;
  shape: DomSurfaceOptions["shape"];
  elevation: number;
  thickness: number;
  bevelWidth: number;
  profile: HeightProfile;
  material: string;
  castsShadow: boolean;
  receivesShadow: boolean;
}

/** Stable identity for MaskSource objects so the options key changes exactly
 * when the mask object changes (renderer #19 SDF cache keys on identity). */
const maskIds = new WeakMap<object, number>();
let maskIdCounter = 0;
function maskObjectId(mask: MaskSource): number {
  let id = maskIds.get(mask);
  if (id === undefined) {
    id = ++maskIdCounter;
    maskIds.set(mask, id);
  }
  return id;
}

function surfaceOptionsKey(options: PhysicalSurfaceOptions): string {
  const shape = options.shape;
  const shapeKey =
    shape.kind === "mask"
      ? `mask:${maskObjectId(shape.mask)}`
      : `rr:${shape.radius ?? ""}`;
  return [
    options.id,
    shapeKey,
    options.elevation,
    options.thickness,
    options.bevelWidth,
    options.profile.kind,
    options.material,
    options.castsShadow,
    options.receivesShadow,
  ].join("|");
}

/** Compose multiple refs onto one element (forwarded ref + internal ref). */
export function mergeRefs<T>(...refs: Array<Ref<T> | undefined>): Ref<T> {
  return (node: T | null) => {
    for (const ref of refs) {
      if (typeof ref === "function") {
        ref(node);
      } else if (ref !== null && ref !== undefined) {
        (ref as MutableRefObject<T | null>).current = node;
      }
    }
  };
}

export const Surface = forwardRef<HTMLElement, SurfaceInnerProps>(function Surface(
  {
    as = "div",
    className,
    style,
    sceneId: sceneIdProp,
    shape,
    elevation,
    thickness,
    bevelWidth,
    profile,
    material,
    castsShadow,
    receivesShadow,
    variant,
    radius,
    materialOverrides,
    children,
    ...rest
  },
  forwardedRef,
) {
  const ctx = useContext(UkiboriContext);
  const elementRef = useRef<HTMLElement | null>(null);
  // Unconditional hooks: useId() is always called; the DOM `id` prop is a
  // separate concern and is forwarded to the element untouched.
  const fallbackSceneId = useId();
  const sceneId = sceneIdProp ?? fallbackSceneId;

  const physicalOptions: PhysicalSurfaceOptions = {
    id: sceneId,
    shape: shape ?? { kind: "roundedRect" },
    elevation: elevation ?? 0,
    thickness: thickness ?? 0,
    bevelWidth: bevelWidth ?? 0,
    profile: profile ?? { kind: "bevel" },
    material: material ?? "silicone",
    castsShadow: castsShadow ?? true,
    receivesShadow: receivesShadow ?? true,
  };
  const optionsKey = surfaceOptionsKey(physicalOptions);

  // Keep the latest options for the effects (refs avoid stale closures).
  const optionsRef = useRef(physicalOptions);
  optionsRef.current = physicalOptions;

  // Registration ownership: this component tracks whether IT acquired the
  // registration, so a failed register() (e.g. duplicate sceneId owned by
  // another surface) can never release someone else's registration, and
  // updates only ever touch this component's own entry.
  const registrationRef = useRef(false);
  const canRegister = ctx.mode === "physical" && ctx.layer !== null && shape !== null;

  // Register/unregister the scene node (mount / mode / layer / sceneId /
  // registration-eligibility changes). Prop updates never pass through this
  // path — they go to the retained update effect below.
  useEffect(() => {
    if (!canRegister) {
      return;
    }
    const element = elementRef.current;
    if (element === null) {
      return;
    }
    const layer: UkiboriDom = ctx.layer!;
    try {
      layer.register(element, optionsRef.current);
      registrationRef.current = true;
    } catch (error) {
      registrationRef.current = false;
      ctx.reportError(error);
    }
    return () => {
      if (!registrationRef.current) {
        return;
      }
      registrationRef.current = false;
      try {
        layer.unregister(sceneId);
      } catch (error) {
        ctx.reportError(error);
      }
    };
  }, [canRegister, ctx.layer, sceneId, ctx.reportError]);

  // Retained updates: prop changes call updateSurface, keeping insertion
  // order stable. The register effect above runs first in the same commit,
  // and only this component's own registration is updated.
  useEffect(() => {
    if (!canRegister || !registrationRef.current) {
      return;
    }
    const layer: UkiboriDom = ctx.layer!;
    try {
      layer.updateSurface(sceneId, optionsRef.current);
    } catch (error) {
      ctx.reportError(error);
    }
  }, [optionsKey, canRegister, ctx.layer, sceneId, ctx.reportError]);

  // ---- CSS approximation fallback (backend="css" only) ----
  const cssStyle = useMemo<CSSProperties | undefined>(() => {
    if (ctx.mode !== "css") {
      return undefined;
    }
    const normalizedVariant: Variant = variant === "inset" ? "inset" : "raised";
    const normalizedMaterial = normalizeMaterialName(material as MaterialName);
    const tokens = resolveMaterialTokens(normalizedMaterial, materialOverrides);
    const safeElevation = sanitizeNumber(elevation, ELEVATION_DEFAULT, 0, ELEVATION_MAX);
    const safeRadius = sanitizeNumber(radius, RADIUS_DEFAULT, 0, RADIUS_MAX);
    const spec = getShadowSpec({
      light: ctx.light,
      elevation: safeElevation,
      intensity: ctx.intensity,
      variant: normalizedVariant,
    });
    const scaled = applyMaterialScales(spec, tokens);
    const insetKeyword = normalizedVariant === "inset" ? "inset " : "";
    return {
      "--ukibori-variant": normalizedVariant,
      "--ukibori-material": normalizedMaterial,
      "--ukibori-elevation": `${safeElevation}px`,
      "--ukibori-radius": `${safeRadius}px`,
      "--ukibori-color": ctx.color,
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.mode, ctx.color, ctx.light, ctx.intensity, variant, radius, material, materialOverrides, elevation]);

  const mergedStyle =
    cssStyle !== undefined ? { ...cssStyle, ...style } : style;

  return createElement(as, {
    ...rest,
    ref: mergeRefs(forwardedRef, elementRef),
    className,
    style: mergedStyle,
  }, children);
}) as unknown as SurfaceType;

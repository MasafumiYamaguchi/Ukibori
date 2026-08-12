import type { ComponentPropsWithRef, CSSProperties, ElementType, ReactNode } from "react";
import type {
  CompositeOptions,
  DomEnvironmentState,
  DomShadowOptions,
  DomShape,
  UkiboriDom,
} from "ukibori-dom";
import type { HeightProfile } from "ukibori-renderer";
import type { MaterialTokensOverride } from "./core/materials";

/**
 * #21 React API types.
 *
 * The React layer is a THIN lifecycle/API layer over `ukibori-dom` +
 * `ukibori-renderer`. It never moves renderer semantics into React: the
 * physical pipeline (SDF -> height field -> material lighting -> cast
 * shadows) stays in the renderer/DOM layer, and this package only wires
 * React lifecycle to it. The only CSS output here is the EXPLICITLY LABELED
 * approximation fallback (`backend="css"`), which is NOT physical rendering.
 */

export interface LightVector {
  x: number;
  y: number;
  z: number;
}

/** CSS-approximation material names (fallback path only; glass has no
 * renderer equivalent). */
export type MaterialName = "silicone" | "matte" | "glass" | "metal";

/** CSS-approximation variant (fallback path only — the height-field renderer
 * has no "inset" carving, see renderer #18 height-field constraints). */
export type Variant = "raised" | "inset";

/**
 * Backend policy. Honest capability model:
 *
 * - `"auto"` / `"cpu"`: the physical layer via the CPU reference renderer —
 *   the only COMPLETE pipeline in this repository today. When a real WebGPU
 *   compute pipeline lands (the renderer's WebGPU backend currently reports
 *   `compute: false`), `"auto"` will prefer it. A selectable `"webgpu"`
 *   value is deliberately NOT offered until then — requesting a fake WebGPU
 *   path would misrepresent capabilities.
 * - `"css"`: the box-shadow approximation fallback, explicitly labeled as an
 *   approximation. It is not physical rendering and must not be advertised
 *   as such.
 */
export type UkiboriBackend = "auto" | "cpu" | "css";

/**
 * Enhancement mode of a Surface:
 *
 * - `"none"`: plain semantic DOM (SSR, provider-less, or before the
 *   post-hydration enhancement effect runs)
 * - `"physical"`: registered into the provider's `UkiboriDom` retained scene
 * - `"css"`: box-shadow approximation fallback (only under `backend="css"`)
 */
export type UkiboriMode = "none" | "physical" | "css";

/**
 * Render quality policy -> render-target scale factor applied on top of
 * `devicePixelRatio` (a render-target concern only; scene units stay CSS
 * pixels, renderer #13). The CPU renderer is the reference implementation,
 * so lower qualities reduce texel count and shadow cost.
 */
export type UkiboriQuality = "low" | "medium" | "high";

export interface UkiboriProps {
  /** Backend policy (default "auto"). */
  backend?: UkiboriBackend;
  /** Shared directional light (renderer #13 convention: points TOWARD the
   * light). Used by the physical layer and the CSS fallback. */
  light?: LightVector;
  intensity?: number;
  /**
   * Shared environment illumination for the physical layer (#22): a uniform
   * fill independent of the directional light, applied BEFORE exposure and
   * sRGB encoding. Three independent scene/shared controls:
   *
   * - `intensity`: overall strength (0 disables the environment; the output
   *   stays close to the ambient + direct response). Finite >= 0; default 0.5.
   * - `diffuseIntensity`: 0..1 share of the environment applied to diffuse
   *   (0 = no environment diffuse). Default 1.
   * - `specularIntensity`: 0..1 share of the environment applied to
   *   specular (0 = no environment specular, the metal black-drop lift is
   *   off). Default 1.
   */
  environment?: Partial<DomEnvironmentState>;
  /**
   * Exposure multiplier for the physical layer (#22): applied to the
   * linear lighting result (ambient + direct + environment) before sRGB
   * encoding. 0 = black, very large finite values saturate to white.
   * Finite >= 0; default 1.
   */
  exposure?: number;
  /** Base color for the CSS approximation fallback. */
  color?: string;
  /**
   * Stage element for the #20 stage-root overlay contract. Defaults to the
   * provider's own wrapper element (which contains the surfaces). The
   * provider owns the stage relationship and disposes it cleanly on unmount.
   * Client-only: never read during SSR.
   */
  stage?: Element;
  /** Render quality policy (maps to the render-target scale). */
  quality?: UkiboriQuality;
  /** Exact render-target dpr override (overrides the quality policy). */
  dpr?: number | (() => number);
  /** Scene-region shadow margin (CSS px, forwarded to the layer). */
  margin?: number;
  /** Cast-shadow pass options (CSS px, forwarded; dpr-invariant, #20). */
  shadow?: DomShadowOptions;
  /** Compositor mapping for the overlay. */
  compositing?: CompositeOptions;
  /**
   * High-contrast policy. `"auto"` (default): `prefers-contrast: more` /
   * `forced-colors: active` disables the physical layer so the app's own
   * high-contrast styles apply to the untouched semantic DOM. `true` forces
   * this off-enhancement, `false` keeps enhancement regardless.
   */
  highContrast?: boolean | "auto";
  /** Wrapper element (the stage) props. */
  className?: string;
  style?: CSSProperties;
  /** Renderer/integration error reporter (default `console.error`). */
  onError?: (error: unknown) => void;
  /** Called with the created `UkiboriDom` (or null) — test/advanced seam. */
  onReady?: (layer: UkiboriDom | null) => void;
  /** Render scheduler forwarded to the layer — test seam. */
  schedule?: (cb: () => void) => void;
  children?: ReactNode;
}

export interface SurfaceOwnProps {
  /** Polymorphic element type; semantic elements stay real (button, input, ...). */
  as?: ElementType;
  /**
   * RENDERER scene identity, STABLE for the mounted lifetime (required
   * invariant for the physical path). Defaults to an unconditional `useId()`.
   * This is separate from the ordinary DOM `id` prop (which is forwarded to
   * the element untouched). Prop updates use the retained `updateSurface`
   * path so the scene insertion/paint order never changes.
   */
  sceneId?: string;
  /** Shape source (renderer #13/#19). Defaults to a rounded rect with the
   * corner radius measured from the element's CSS. `null` = do not register
   * (plain semantic DOM; used by <UkiboriText> before its mask exists). */
  shape?: DomShape | null;
  /** Absolute scene z of the surface base (CSS px, #13). */
  elevation?: number;
  /** Profile height range above the base (CSS px). */
  thickness?: number;
  /** Inward bevel band width (CSS px). */
  bevelWidth?: number;
  /** Local height profile descriptor (default bevel). */
  profile?: HeightProfile;
  /** Renderer material ref (presets: silicone / matte / metal; or a table
   * ref provided to the layer). */
  material?: string;
  castsShadow?: boolean;
  receivesShadow?: boolean;
  /** CSS-approximation variant — applied only in `backend="css"` mode. */
  variant?: Variant;
  /** CSS-approximation corner radius — applied only in css mode (the
   * physical path uses `shape.radius` or the measured border-radius). */
  radius?: number;
  /** CSS-approximation material token overrides (css mode only). */
  materialOverrides?: MaterialTokensOverride;
}

/**
 * Polymorphic props for Surface: DOM props are resolved per element type C,
 * so `as="button"` accepts button-specific props (type, onClick, ...) and
 * rejects props of other elements at compile time.
 */
export type PolymorphicSurfaceProps<C extends ElementType = "div"> = Omit<
  ComponentPropsWithRef<C>,
  keyof SurfaceOwnProps | "as"
> &
  SurfaceOwnProps & { as?: C };

/** UkiboriText: a DOM-owned accessible text node whose glyph participates in
 * the physical scene through the #19 mask geometry path. It is a span with
 * the full polymorphic Surface props (style, className, events, ...). */
export type UkiboriTextProps = Omit<PolymorphicSurfaceProps<"span">, "children"> & {
  text: string;
  /** Canvas font used for the mask rasterization (defaults to the element's
   * computed font). Rasterization stays outside the renderer core. */
  font?: string;
};

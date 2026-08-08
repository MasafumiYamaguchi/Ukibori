/**
 * Ukibori — React API for the physical 2.5D renderer (#21).
 *
 * A THIN lifecycle/API layer over `ukibori-dom` + `ukibori-renderer`:
 *
 *   DOM UI -> 2.5D height field -> physical material lighting + cross-element
 *   cast shadows (renderer #13–#19), composited onto a stage-root overlay
 *   (#20). The React layer never moves renderer semantics into React.
 *
 * The only CSS output in this package is the box-shadow APPROXIMATION
 * fallback (`backend="css"` on <Ukibori>). It is explicitly labeled an
 * approximation — it is NOT physical/PBR rendering and must not be
 * advertised as such.
 */
export { Ukibori } from "./components/Ukibori";
export { Surface, ELEVATION_DEFAULT, RADIUS_DEFAULT } from "./components/Surface";
export { UkiboriText } from "./components/UkiboriText";
export { UkiboriContext, DEFAULT_COLOR, DEFAULT_INTENSITY } from "./context";
export { DEFAULT_LIGHT, isValidVector, normalizeLight } from "./core/light";
export { ELEVATION_MAX, INTENSITY_MAX, RADIUS_MAX, getShadowSpec } from "./core/shadow";
export {
  DEFAULT_MATERIAL,
  MATERIAL_PRESETS,
  applyMaterialScales,
  isMaterialName,
  normalizeMaterialName,
  resolveMaterialTokens,
} from "./core/materials";
export type { MaterialTokens, MaterialTokensOverride } from "./core/materials";
export type { ShadowOptions, ShadowSpec } from "./core/shadow";
export { isBrowser, prefersHighContrast, prefersReducedMotion } from "./env";
export type {
  LightVector,
  MaterialName,
  PolymorphicSurfaceProps,
  SurfaceOwnProps,
  UkiboriBackend,
  UkiboriMode,
  UkiboriProps,
  UkiboriQuality,
  UkiboriTextProps,
  Variant,
} from "./types";

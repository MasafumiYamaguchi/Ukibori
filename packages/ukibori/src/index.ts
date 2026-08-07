export { Ukibori } from "./components/Ukibori";
export { Surface } from "./components/Surface";
export { UkiboriContext, DEFAULT_COLOR } from "./context";
export { DEFAULT_LIGHT, LIGHT_PRECISION, isValidVector, normalizeLight } from "./core/light";
export { ELEVATION_MAX, INTENSITY_MAX, PX_PRECISION, getShadowSpec } from "./core/shadow";
export type { ShadowOptions, ShadowSpec } from "./core/shadow";
export type {
  LightVector,
  MaterialName,
  Variant,
  UkiboriProps,
  SurfaceOwnProps,
  SurfaceProps,
} from "./types";

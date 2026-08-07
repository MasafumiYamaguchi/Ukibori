export { Ukibori } from "./components/Ukibori";
export { Surface } from "./components/Surface";
export { UkiboriContext, DEFAULT_COLOR, DEFAULT_INTENSITY } from "./context";
export { DEFAULT_LIGHT, isValidVector, normalizeLight } from "./core/light";
export { ELEVATION_MAX, INTENSITY_MAX, RADIUS_MAX, getShadowSpec } from "./core/shadow";
export type { ShadowOptions, ShadowSpec } from "./core/shadow";
export type {
  LightVector,
  MaterialName,
  Variant,
  UkiboriProps,
  SurfaceOwnProps,
  PolymorphicSurfaceProps,
} from "./types";

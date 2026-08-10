import { createContext } from "react";
import type { UkiboriDom } from "ukibori-dom";
import { DEFAULT_EXPOSURE as DEFAULT_EXPOSURE_RENDERER } from "ukibori-renderer";
import { DEFAULT_LIGHT, normalizeLight } from "./core/light";
import type { LightVector, UkiboriBackend, UkiboriMode } from "./types";

export const DEFAULT_COLOR = "#e4e8ef";
export const DEFAULT_INTENSITY = 1;
/** Default exposure multiplier (identity; renderer #22 default). */
export const DEFAULT_EXPOSURE = DEFAULT_EXPOSURE_RENDERER;

// Context default (used when no <Ukibori> provider wraps a Surface): mode
// "none" — plain semantic DOM, no physical layer and no CSS approximation.
// The light is normalized up-front so provider-less rendering is
// deterministic.
const DEFAULT_NORMALIZED_LIGHT: LightVector = normalizeLight(DEFAULT_LIGHT);

export interface UkiboriContextValue {
  /** Enhancement mode of surfaces under this provider. */
  mode: UkiboriMode;
  /** The provider's single UkiboriDom (physical mode, after enhancement). */
  layer: UkiboriDom | null;
  /** Backend policy as requested on the provider. */
  backend: UkiboriBackend;
  /** Surface registration/render error reporter (does not throw). */
  reportError: (error: unknown) => void;
  /** CSS-approximation environment (used only in css mode). */
  light: LightVector;
  intensity: number;
  color: string;
}

export const UkiboriContext = createContext<UkiboriContextValue>({
  mode: "none",
  layer: null,
  backend: "auto",
  reportError: () => undefined,
  light: DEFAULT_NORMALIZED_LIGHT,
  intensity: DEFAULT_INTENSITY,
  color: DEFAULT_COLOR,
});

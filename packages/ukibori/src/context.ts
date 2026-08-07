import { createContext } from "react";
import type { LightVector } from "./types";
import { DEFAULT_LIGHT, normalizeLight } from "./core/light";

export const DEFAULT_COLOR = "#e4e8ef";
export const DEFAULT_INTENSITY = 1;

// Context default (used when no <Ukibori> provider wraps a Surface).
// The light is normalized up-front so out-of-provider rendering is
// deterministic and matches provider behavior.
const DEFAULT_NORMALIZED_LIGHT: LightVector = normalizeLight(DEFAULT_LIGHT);

export interface UkiboriContextValue {
  light: LightVector;
  intensity: number;
  color: string;
}

export const UkiboriContext = createContext<UkiboriContextValue>({
  light: DEFAULT_NORMALIZED_LIGHT,
  intensity: DEFAULT_INTENSITY,
  color: DEFAULT_COLOR,
});

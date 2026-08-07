import { createContext } from "react";
import type { LightVector } from "./types";

export const DEFAULT_LIGHT: LightVector = { x: -0.6, y: -0.8, z: 1 };

export const DEFAULT_COLOR = "#e4e8ef";

export interface UkiboriContextValue {
  light: LightVector;
  intensity: number;
  color: string;
}

export const UkiboriContext = createContext<UkiboriContextValue>({
  light: DEFAULT_LIGHT,
  intensity: 1,
  color: DEFAULT_COLOR,
});

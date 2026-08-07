import { createContext } from "react";
import type { LightVector } from "./types";
import { DEFAULT_LIGHT } from "./core/light";

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

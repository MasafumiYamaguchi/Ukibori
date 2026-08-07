import { UkiboriContext, DEFAULT_COLOR } from "../context";
import { DEFAULT_LIGHT } from "../core/light";
import type { UkiboriProps } from "../types";

export function Ukibori({
  light = DEFAULT_LIGHT,
  intensity = 1,
  color = DEFAULT_COLOR,
  children,
}: UkiboriProps) {
  return (
    <UkiboriContext.Provider value={{ light, intensity, color }}>
      {children}
    </UkiboriContext.Provider>
  );
}

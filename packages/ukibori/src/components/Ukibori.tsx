import { useMemo } from "react";
import { DEFAULT_COLOR, DEFAULT_INTENSITY, UkiboriContext } from "../context";
import { DEFAULT_LIGHT, normalizeLight } from "../core/light";
import { INTENSITY_MAX } from "../core/shadow";
import { sanitizeNumber } from "../core/math";
import type { UkiboriProps } from "../types";

export function Ukibori({
  light = DEFAULT_LIGHT,
  intensity = DEFAULT_INTENSITY,
  color = DEFAULT_COLOR,
  children,
}: UkiboriProps) {
  const value = useMemo(() => {
    const normalizedLight = normalizeLight(light);
    const safeIntensity = sanitizeNumber(intensity, DEFAULT_INTENSITY, 0, INTENSITY_MAX);
    const safeColor =
      typeof color === "string" && color.trim().length > 0 ? color : DEFAULT_COLOR;
    return { light: normalizedLight, intensity: safeIntensity, color: safeColor };
  }, [light, intensity, color]);

  return <UkiboriContext.Provider value={value}>{children}</UkiboriContext.Provider>;
}

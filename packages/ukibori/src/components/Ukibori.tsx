import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { UkiboriDom } from "ukibori-dom";
import type { DomLightState, DomShadowOptions } from "ukibori-dom";
import { DEFAULT_COLOR, DEFAULT_INTENSITY, UkiboriContext } from "../context";
import { DEFAULT_LIGHT, normalizeLight } from "../core/light";
import { INTENSITY_MAX } from "../core/shadow";
import { sanitizeNumber } from "../core/math";
import { prefersHighContrast } from "../env";
import type { UkiboriMode, UkiboriProps, UkiboriQuality } from "../types";

/**
 * <Ukibori> — the shared physical-layer provider (#21).
 *
 * Owns exactly ONE `UkiboriDom` integration instance for the whole subtree:
 * the shared light/environment, the backend/fallback policy, the
 * quality/DPR policy, and the scene lifecycle. Every <Surface> /
 * <UkiboriText> inside registers into this one retained scene (never a
 * per-surface renderer).
 *
 * Lifecycle:
 *
 * - SSR / first render: mode "none" — ordinary semantic DOM, no window /
 *   document / canvas / WebGPU / UkiboriDom touched.
 * - After hydration + effects (capability detection -> integration init ->
 *   surface registration): the layer is created once and the provider renders
 *   a wrapper element that becomes the #20 stage (the overlay canvas is
 *   inserted inside it; `overlay.stage` overrides). The stage relationship is
 *   disposed cleanly on unmount or when the config changes.
 * - `backend="css"`: no layer at all — surfaces render the CSS approximation
 *   (box-shadow), an EXPLICITLY LABELED fallback that is not physical
 *   rendering.
 * - `highContrast="auto"` (default): a `prefers-contrast: more` /
 *   `forced-colors: active` user preference disables enhancement so the
 *   app's own high-contrast styles apply to the untouched semantic DOM.
 *
 * Static scenes stay idle: nothing here animates or renders continuously.
 */

const QUALITY_DPR: Record<UkiboriQuality, number> = {
  low: 0.75,
  medium: 1,
  high: 1.5,
};

export function Ukibori({
  backend = "auto",
  light = DEFAULT_LIGHT,
  intensity = DEFAULT_INTENSITY,
  color = DEFAULT_COLOR,
  stage,
  quality = "medium",
  dpr,
  margin,
  shadow,
  compositing,
  highContrast = "auto",
  className,
  style,
  onError,
  onReady,
  schedule,
  children,
}: UkiboriProps) {
  // ---- CSS approximation environment (also used by the physical light) ----
  const cssEnv = useMemo(() => {
    const normalizedLight = normalizeLight(light);
    const safeIntensity = sanitizeNumber(intensity, DEFAULT_INTENSITY, 0, INTENSITY_MAX);
    const safeColor =
      typeof color === "string" && color.trim().length > 0 ? color : DEFAULT_COLOR;
    const key = `${normalizedLight.x},${normalizedLight.y},${normalizedLight.z}|${safeIntensity}|${safeColor}`;
    return {
      light: normalizedLight,
      intensity: safeIntensity,
      color: safeColor,
      key,
    };
    // Light vector fields are primitives: stable across re-renders with the
    // same values even when the caller passes a fresh object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [light.x, light.y, light.z, intensity, color]);

  // Callbacks are kept in refs so inline functions never churn the layer.
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const scheduleRef = useRef(schedule);
  scheduleRef.current = schedule;

  const reportError = useMemo(
    () => (error: unknown) => {
      const handler = onErrorRef.current ?? ((e: unknown) => console.error(e));
      handler(error);
    },
    [],
  );

  // ---- high-contrast policy (client-only detection) ----
  const [highContrastEnabled, setHighContrastEnabled] = useState(false);
  useEffect(() => {
    if (highContrast === true) {
      setHighContrastEnabled(true);
      return;
    }
    if (highContrast === false) {
      setHighContrastEnabled(false);
      return;
    }
    setHighContrastEnabled(prefersHighContrast());
  }, [highContrast]);

  // ---- layer lifecycle ----
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [layer, setLayer] = useState<UkiboriDom | null>(null);

  // The physical configuration is keyed by a serialized string so inline
  // object props cannot recreate the layer on unrelated re-renders.
  const configKey = [
    backend,
    cssEnv.key,
    margin ?? "",
    JSON.stringify(shadow),
    JSON.stringify(compositing),
    String(dpr),
    quality,
  ].join("|");
  const physicalConfig = useMemo(() => {
    if (backend === "css") {
      return null;
    }
    const lightState: DomLightState = {
      direction: cssEnv.light,
      intensity: cssEnv.intensity,
    };
    const shadowOptions: DomShadowOptions | undefined = shadow;
    return { lightState, margin, shadow: shadowOptions, compositing };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configKey]);

  useEffect(() => {
    if (backend === "css" || highContrastEnabled) {
      setLayer(null);
      onReadyRef.current?.(null);
      return;
    }
    if (physicalConfig === null) {
      return;
    }
    let created: UkiboriDom | null = null;
    try {
      created = new UkiboriDom({
        light: physicalConfig.lightState,
        margin: physicalConfig.margin,
        shadow: physicalConfig.shadow,
        compositing: physicalConfig.compositing,
        dpr: dpr ?? (() => (window.devicePixelRatio ?? 1) * QUALITY_DPR[quality]),
        schedule: scheduleRef.current,
        overlay: { stage: stage ?? stageRef.current ?? undefined },
        onError: reportError,
      });
    } catch (error) {
      reportError(error);
      onReadyRef.current?.(null);
      return;
    }
    setLayer(created);
    onReadyRef.current?.(created);
    return () => {
      created.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, physicalConfig, stage, highContrastEnabled, reportError]);

  const mode: UkiboriMode =
    backend === "css" ? "css" : layer !== null ? "physical" : "none";

  const value = useMemo(
    () => ({
      mode,
      layer,
      backend,
      reportError,
      light: cssEnv.light,
      intensity: cssEnv.intensity,
      color: cssEnv.color,
    }),
    [mode, layer, backend, reportError, cssEnv],
  );

  const wrapperStyle: CSSProperties | undefined = style;

  return (
    <UkiboriContext.Provider value={value}>
      <div ref={stageRef} className={className} style={wrapperStyle}>
        {children}
      </div>
    </UkiboriContext.Provider>
  );
}

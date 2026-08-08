import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { UkiboriDom } from "ukibori-dom";
import type { DomLightState, DomShadowOptions } from "ukibori-dom";
import { DEFAULT_COLOR, DEFAULT_INTENSITY, UkiboriContext } from "../context";
import { DEFAULT_LIGHT, normalizeLight } from "../core/light";
import { INTENSITY_MAX } from "../core/shadow";
import { sanitizeNumber } from "../core/math";
import { detectCanvas2dSupport, prefersHighContrast } from "../env";
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
 * - Post-hydration capability resolution: `backend="auto"` verifies that the
 *   real CPU/Canvas presentation path is usable (`detectCanvas2dSupport`)
 *   before entering physical mode. When Canvas2D is unavailable, the mode is
 *   the explicitly labeled CSS approximation fallback instead of suppressing
 *   DOM surfaces while an overlay silently paints nothing. WebGPU stays
 *   unselectable until a real compute pipeline exists.
 * - Enhancement (integration init -> surface registration): the layer is
 *   created once and the provider renders a wrapper element that becomes the
 *   #20 stage (the overlay canvas is inserted inside it; `overlay.stage`
 *   overrides). The stage relationship is disposed cleanly on unmount or on
 *   STRUCTURAL changes (backend / stage / high-contrast policy).
 * - Ordinary physical prop changes (light, intensity, shadow, dpr, quality,
 *   margin, compositing) are pushed to the EXISTING layer through its setter
 *   APIs — the layer and every retained surface registration survive.
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

  // ---- post-hydration capability resolution ----
  // "auto" (and explicit "cpu") must verify the real CPU/Canvas presentation
  // path before entering physical mode. Skipped for backend="css" (the
  // approximation fallback needs no canvas).
  const [canvas2dAvailable, setCanvas2dAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    if (backend === "css") {
      setCanvas2dAvailable(null);
      return;
    }
    setCanvas2dAvailable(detectCanvas2dSupport());
  }, [backend]);

  // ---- layer lifecycle ----
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [layer, setLayer] = useState<UkiboriDom | null>(null);

  const physicalRequested = backend !== "css" && !highContrastEnabled;

  // STRUCTURAL effect dependencies are IDENTITY-based: `stage` is a DOM
  // Element and `backend`/`highContrastEnabled` are primitives. Elements must
  // never be serialized into a string key (two different elements can
  // stringify identically), so a stage switch always recreates the layer on
  // the new stage.
  useEffect(() => {
    if (backend === "css" || highContrastEnabled) {
      setLayer(null);
      onReadyRef.current?.(null);
      return;
    }
    if (canvas2dAvailable === null) {
      // Capability resolution still pending: keep mode "none" (plain DOM).
      return;
    }
    if (!canvas2dAvailable) {
      // Canvas2D presentation is unusable: the physical overlay could not
      // present anything. Fall back to the explicitly labeled CSS
      // approximation instead of suppressing DOM surfaces silently.
      reportError(
        new Error(
          "Ukibori: Canvas2D presentation unavailable — using the explicitly labeled CSS approximation fallback",
        ),
      );
      setLayer(null);
      onReadyRef.current?.(null);
      return;
    }
    let created: UkiboriDom | null = null;
    try {
      created = new UkiboriDom({
        light: {
          direction: cssEnv.light,
          intensity: cssEnv.intensity,
        } satisfies DomLightState,
        margin,
        shadow,
        compositing,
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
  }, [backend, stage, highContrastEnabled, canvas2dAvailable, reportError]);

  // Ordinary value props (light/intensity/shadow/margin/compositing/quality)
  // are plain data and are serialized for a stable update key; `dpr` may be
  // a FUNCTION and is keyed by IDENTITY so a changed provider function (even
  // with identical source text) is always pushed to the layer.
  const updateDataKey = [
    cssEnv.key,
    JSON.stringify(shadow),
    JSON.stringify(compositing),
    margin ?? "",
    quality,
  ].join("|");

  // Retained physical updates: FULL replacement through the EXISTING layer's
  // setters. Removing a React prop resets the corresponding option to its
  // default (setShadow({}) / setMargin(undefined) / setCompositing({})), and
  // nothing is merged — stale fields never survive a later call. The layer
  // and every retained registration survive ordinary prop changes.
  useEffect(() => {
    if (layer === null) {
      return;
    }
    const current: UkiboriDom = layer;
    current.setLight(
      { x: cssEnv.light.x, y: cssEnv.light.y, z: cssEnv.light.z },
      cssEnv.intensity,
    );
    current.setShadow(shadow ?? {});
    current.setMargin(margin);
    current.setCompositing(compositing ?? {});
    current.setDpr(dpr ?? (() => (window.devicePixelRatio ?? 1) * QUALITY_DPR[quality]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layer, updateDataKey, dpr]);

  const mode: UkiboriMode =
    backend === "css"
      ? "css"
      : physicalRequested && canvas2dAvailable === false
        ? "css"
        : layer !== null
          ? "physical"
          : "none";

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

  return (
    <UkiboriContext.Provider value={value}>
      <div ref={stageRef} className={className} style={style}>
        {children}
      </div>
    </UkiboriContext.Provider>
  );
}

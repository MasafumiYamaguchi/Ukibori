import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { UkiboriDom } from "ukibori-dom";
import type { DomBackend, DomLightState, DomShadowOptions } from "ukibori-dom";
import { sanitizeEnvironment, sanitizeExposure } from "ukibori-renderer";
import {
  DEFAULT_COLOR,
  DEFAULT_EXPOSURE,
  DEFAULT_INTENSITY,
  UkiboriContext,
} from "../context";
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
 *   before entering physical mode (the honest CPU fallback needs a 2d
 *   context). When Canvas2D is unavailable, the mode is the explicitly
 *   labeled CSS approximation fallback instead of suppressing DOM surfaces
 *   while an overlay silently paints nothing.
 * - Enhancement (integration init -> surface registration): the layer is
 *   created through the ASYNC `UkiboriDom.create()` path (backend
 *   auto/cpu/webgpu). `"auto"` requests a real `navigator.gpu`
 *   adapter/device and uses the #29/#31 `GpuScenePipeline`'s DIRECT canvas
 *   presentation (no readback, no 2D copy) when available; any GPU
 *   init/render/device-loss failure switches once to the honest CPU
 *   reference path. `"webgpu"` is WebGPU-only — when the GPU cannot be
 *   initialized the provider reports the error and falls back to the labeled
 *   CSS approximation. The provider renders a wrapper element that becomes
 *   the #20 stage (the overlay canvas is inserted inside it;
 *   `overlay.stage` overrides). The stage relationship is disposed cleanly
 *   on unmount or on STRUCTURAL changes (backend / stage / high-contrast
 *   policy), and a cancelled in-flight creation (StrictMode double-invoke,
 *   structural switch) is disposed before it can leak.
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
  angularRadius,
  environment = {},
  exposure = DEFAULT_EXPOSURE,
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

  // #41 apparent light size (radians, dimensionless): finite >= 0 forwarded
  // to the physical layer; anything else means "renderer default" (hard).
  const safeAngularRadius =
    Number.isFinite(angularRadius) && (angularRadius ?? 0) >= 0 ? angularRadius : undefined;

  // Physical-only image-level controls (#22): environment illumination and
  // exposure. Sanitized with the RENDERER's own policy so the React entry
  // yields exactly the scene values: environment intensity finite >= 0
  // (0 = off; NaN / +-Infinity / negative fall back to the default 0.5),
  // the diffuse/specular shares finite clamped into [0, 1] (negative -> 0;
  // NaN / +-Infinity fall back to the default 1), exposure finite >= 0
  // (NaN / +-Infinity / negative fall back to the identity 1).
  const envEnv = useMemo(() => {
    const env = sanitizeEnvironment(environment);
    const key = `${env.intensity}|${env.diffuseIntensity}|${env.specularIntensity}`;
    return {
      intensity: env.intensity,
      diffuseIntensity: env.diffuseIntensity,
      specularIntensity: env.specularIntensity,
      key,
    };
    // The environment fields are primitives: stable across re-renders with
    // the same values even when the caller passes a fresh object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [environment?.intensity, environment?.diffuseIntensity, environment?.specularIntensity]);
  const safeExposure = sanitizeExposure(exposure);

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
  // Explicit backend="webgpu" whose GPU init failed: the provider reports the
  // error and enters the explicitly labeled CSS approximation so surfaces are
  // never suppressed-but-unpainted.
  const [webgpuFailed, setWebgpuFailed] = useState(false);

  const physicalRequested = backend !== "css" && !highContrastEnabled;

  // STRUCTURAL effect dependencies are IDENTITY-based: `stage` is a DOM
  // Element and `backend`/`highContrastEnabled` are primitives. Elements must
  // never be serialized into a string key (two different elements can
  // stringify identically), so a stage switch always recreates the layer on
  // the new stage.
  useEffect(() => {
    if (backend === "css" || highContrastEnabled) {
      setLayer(null);
      setWebgpuFailed(false);
      onReadyRef.current?.(null);
      return;
    }
    if (canvas2dAvailable === null) {
      // Capability resolution still pending: keep mode "none" (plain DOM).
      return;
    }
    if (!canvas2dAvailable) {
      // Canvas2D presentation is unusable: the physical overlay (CPU and
      // GPU fallback alike) could not present anything. Fall back to the
      // explicitly labeled CSS approximation instead of suppressing DOM
      // surfaces silently.
      reportError(
        new Error(
          "Ukibori: Canvas2D presentation unavailable — using the explicitly labeled CSS approximation fallback",
        ),
      );
      setLayer(null);
      setWebgpuFailed(false);
      onReadyRef.current?.(null);
      return;
    }
    const domBackend: DomBackend =
      backend === "webgpu" ? "webgpu" : backend === "cpu" ? "cpu" : "auto";
    let cancelled = false;
    let created: UkiboriDom | null = null;
    const init = async () => {
      try {
        created = await UkiboriDom.create({
          backend: domBackend,
          light: {
            direction: cssEnv.light,
            intensity: cssEnv.intensity,
            ...(safeAngularRadius !== undefined ? { angularRadius: safeAngularRadius } : {}),
          } satisfies DomLightState,
          environment: {
            intensity: envEnv.intensity,
            diffuseIntensity: envEnv.diffuseIntensity,
            specularIntensity: envEnv.specularIntensity,
          },
          exposure: safeExposure,
          margin,
          shadow,
          compositing,
          dpr: dpr ?? (() => (window.devicePixelRatio ?? 1) * QUALITY_DPR[quality]),
          schedule: scheduleRef.current,
          overlay: { stage: stage ?? stageRef.current ?? undefined },
          onError: reportError,
        });
      } catch (error) {
        // Only an EXPLICIT webgpu request throws here (auto degrades to CPU
        // inside create()); the failure is reported and the surfaces fall
        // back to the labeled CSS approximation.
        reportError(error);
        onReadyRef.current?.(null);
        if (!cancelled) {
          setWebgpuFailed(domBackend === "webgpu");
        }
        return;
      }
      if (cancelled) {
        // The effect was torn down while the async creation was in flight
        // (StrictMode double-invoke, stage/backend switch, unmount): the
        // late layer must never be published and is disposed immediately.
        created.dispose();
        return;
      }
      setWebgpuFailed(false);
      setLayer(created);
      onReadyRef.current?.(created);
    };
    void init();
    return () => {
      cancelled = true;
      created?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, stage, highContrastEnabled, canvas2dAvailable, reportError]);

  // Ordinary value props (light/intensity/environment/exposure/shadow/
  // margin/compositing/quality) are plain data and are serialized for a
  // stable update key; `dpr` may be a FUNCTION and is keyed by IDENTITY so a
  // changed provider function (even with identical source text) is always
  // pushed to the layer.
  const updateDataKey = [
    cssEnv.key,
    safeAngularRadius === undefined ? "" : String(safeAngularRadius),
    envEnv.key,
    safeExposure,
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
      safeAngularRadius,
    );
    current.setEnvironment({
      intensity: envEnv.intensity,
      diffuseIntensity: envEnv.diffuseIntensity,
      specularIntensity: envEnv.specularIntensity,
    });
    current.setExposure(safeExposure);
    current.setShadow(shadow ?? {});
    current.setMargin(margin);
    current.setCompositing(compositing ?? {});
    current.setDpr(dpr ?? (() => (window.devicePixelRatio ?? 1) * QUALITY_DPR[quality]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layer, updateDataKey, dpr]);

  const mode: UkiboriMode =
    backend === "css" || webgpuFailed
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

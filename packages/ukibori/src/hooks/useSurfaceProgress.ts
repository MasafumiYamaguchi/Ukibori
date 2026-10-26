import { useEffect, useRef, useState } from "react";

export interface SurfaceProgressOptions {
  /** Duration of a transition in ms; default 120. Zero snaps immediately. */
  durationMs?: number;
  /** Default "auto": follow the live prefers-reduced-motion preference. */
  reducedMotion?: boolean | "auto";
}
const clampProgress = (value: number) => Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

/**
 * Optional recipe adapter: interpolate an externally owned interaction state.
 * It owns no DOM events, focus, selection or ARIA. SSR starts at target.
 * Only active transitions request frames; target changes resume at the current
 * value, and completion, preference changes and unmount cancel pending work.
 */
export function useSurfaceProgress(target: number, options: SurfaceProgressOptions = {}): number {
  const end = clampProgress(target);
  const [progress, setProgress] = useState(end);
  const current = useRef(progress);
  const [systemReduced, setSystemReduced] = useState(false);
  const policy = options.reducedMotion ?? "auto";
  useEffect(() => {
    if (policy !== "auto" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setSystemReduced(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [policy]);
  const reduced = policy === "auto" ? systemReduced : policy;
  const rawDuration = options.durationMs ?? 120;
  const duration = Number.isFinite(rawDuration) ? Math.min(1000, Math.max(0, rawDuration)) : 120;
  useEffect(() => {
    if (current.current === end) return;
    if (reduced || duration === 0 || typeof requestAnimationFrame !== "function") {
      current.current = end;
      setProgress(end);
      return;
    }
    const startValue = current.current;
    const startedAt = performance.now();
    let frame: number;
    let active = true;
    const tick = (now: number) => {
      if (!active) return;
      const t = Math.min(1, Math.max(0, (now - startedAt) / duration));
      const next = t === 1 ? end : startValue + (end - startValue) * (1 - (1 - t) ** 3);
      current.current = next;
      setProgress(next);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => { active = false; cancelAnimationFrame(frame); };
  }, [end, duration, reduced]);
  return progress;
}

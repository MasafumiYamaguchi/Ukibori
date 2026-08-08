/**
 * SSR-safe browser environment helpers (#21). These functions never touch
 * `window`/`document`/canvas/WebGPU on the server: they only feature-detect
 * and read preferences on the client. They are the seam for the
 * accessibility policies (reduced motion, high contrast).
 */

/** True only when a real browser DOM environment is available. */
export function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

/** `prefers-reduced-motion` media query. The physical layer is static (no
 * continuous animation), so this is exposed as a policy seam, not as a
 * render switch. */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * High-contrast preference: `prefers-contrast: more` or forced-colors.
 * `Ukibori` uses this for its `highContrast="auto"` policy (physical layer
 * disabled so the app's own high-contrast CSS applies to untouched DOM).
 */
export function prefersHighContrast(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return (
    window.matchMedia("(prefers-contrast: more)").matches ||
    window.matchMedia("(forced-colors: active)").matches
  );
}

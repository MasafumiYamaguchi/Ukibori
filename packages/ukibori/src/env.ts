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

/**
 * Verify the actual CPU/Canvas presentation path is usable (#21): the
 * physical layer presents through a Canvas2D overlay, so `backend="auto"`
 * only enters physical mode when a 2d context can really be created. When it
 * cannot, the provider falls back to the explicitly labeled CSS approximation
 * instead of suppressing DOM surfaces while the overlay paints nothing.
 * Verifies per call (cheap: one probe canvas per provider mount). SSR-safe
 * (never touches the DOM on the server).
 */
export function detectCanvas2dSupport(doc?: Document): boolean {
  if (doc === undefined) {
    if (typeof document === "undefined") {
      return false;
    }
    doc = document;
  }
  let supported = false;
  try {
    const probe = doc.createElement("canvas");
    supported = probe.getContext("2d") !== null;
  } catch {
    supported = false;
  }
  return supported;
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

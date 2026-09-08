import { forwardRef, useId, useImperativeHandle, useMemo, useContext } from "react";
import type { ReactNode } from "react";
import { BakeContext, UkiboriContext } from "../context";
import type { BakeHandle, BakeProps } from "../types";

/**
 * <Bake> — a static physical scene retention boundary (#59).
 *
 * ```tsx
 * const bakeRef = useRef<BakeHandle>(null);
 *
 * <Ukibori>
 *   <Bake ref={bakeRef}>
 *     <SamplerChassis />  {/* static: chassis, panel, labels... *\/}
 *   </Bake>
 *   <InteractivePads />   {/* dynamic: measured on every real change *\/}
 * </Ukibori>
 * ```
 *
 * Semantics:
 *
 * - The subtree's surfaces are registered with the boundary's bake id. After
 *   their initial measurement they are RETAINED: ordinary unrelated DOM
 *   mutations (the conservative document MutationObserver invalidation) and
 *   page scroll no longer re-measure them, and their mask/SDF preprocessing
 *   is not regenerated. They keep participating in the SAME physical scene —
 *   height composition, object/material ownership, cast shadows
 *   (dynamic caster -> baked receiver AND baked caster -> dynamic receiver)
 *   and shared lighting are unchanged, so this is geometry retention, not a
 *   final-image cache.
 * - `bakeRef.current?.invalidate()` re-measures the boundary when its static
 *   content actually changed. The rebuild is scheduled through Ukibori's
 *   normal coalesced update (never synchronous) and repeated calls in the
 *   same frame coalesce into one rebake. Pair it with standard React hooks
 *   instead of a revision prop:
 *
 *   ```tsx
 *   useLayoutEffect(() => {
 *     bakeRef.current?.invalidate();
 *   }, [layoutMode, seed]);
 *   ```
 *
 * - Forced correctness rebakes are automatic: a viewport resize, a font
 *   load, an actual layout change of a baked element (ResizeObserver), or a
 *   physical prop update on the surface re-measure it — stale baked geometry
 *   (baked position != actual DOM position) is never kept.
 * - Nested boundaries are allowed; a surface belongs to the NEAREST enclosing
 *   <Bake>. The DOM stays authoritative (layout, semantics, accessibility,
 *   focus, pointer/keyboard events are never frozen or replaced).
 * - SSR / hydration safe: nothing physical happens during server render, and
 *   `invalidate()` is a safe no-op before the layer exists.
 */
export const Bake = forwardRef<BakeHandle, BakeProps>(function Bake(
  { children }: BakeProps,
  ref,
) {
  const ctx = useContext(UkiboriContext);
  // The boundary id is stable for the mounted lifetime (useId, like the
  // Surface fallback sceneId). It only ever keys the layer's bake groups and
  // never reaches the DOM.
  const bakeId = useId();
  const layer = ctx.layer;
  const handle = useMemo<BakeHandle>(
    () => ({
      invalidate: () => {
        // Provider-less / SSR / pre-hydration: no layer, no physical layer
        // state — a safe no-op.
        layer?.invalidateBake(bakeId);
      },
    }),
    [layer, bakeId],
  );
  useImperativeHandle(ref, () => handle, [handle]);
  return <BakeContext.Provider value={bakeId}>{children}</BakeContext.Provider>;
});

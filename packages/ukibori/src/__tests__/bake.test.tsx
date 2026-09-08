import { act, createRef } from "react";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stubCanvas2d, stubElementRects } from "../test/dom";
import { Bake, Surface, Ukibori } from "../index";
import type { BakeHandle } from "../index";
import type { UkiboriDom } from "ukibori-dom";

/**
 * #59 Bake boundary  EReact API semantics:
 *
 * - <Bake> puts its subtree's surfaces under ONE bake boundary (the nearest
 *   enclosing <Bake>; nested boundaries override).
 * - `bakeRef.current.invalidate()` re-measures exactly that boundary through
 *   the coalesced scheduled update, then returns it to the retained state.
 * - Ordinary unrelated DOM mutations do not re-measure baked surfaces, while
 *   dynamic surfaces keep the existing conservative invalidation semantics.
 * - Provider-less / SSR usage renders plain DOM and invalidate() is a no-op.
 */

const flushAsync = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

/** Per-element DOM measurement counter that delegates to the prototype stub. */
function countRects(el: Element) {
  const proto = Element.prototype.getBoundingClientRect;
  const spy = vi
    .spyOn(el, "getBoundingClientRect")
    .mockImplementation(function (this: Element) {
      return proto.call(this);
    });
  return spy;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("#59 <Bake> boundary", () => {
  it("registers subtree surfaces under the boundary; dynamic surfaces stay outside", async () => {
    stubElementRects();
    stubCanvas2d();
    let layer: UkiboriDom | null = null;
    const bakeRef = createRef<BakeHandle>();
    render(
      <Ukibori schedule={(cb) => cb()} onReady={(l) => (layer = l)}>
        <Bake ref={bakeRef}>
          <Surface sceneId="chassis" elevation={0} thickness={2}>
            chassis
          </Surface>
        </Bake>
        <Surface sceneId="pad" elevation={4} thickness={2}>
          pad
        </Surface>
      </Ukibori>,
    );
    await flushAsync();
    const current = layer!;
    expect(current.registry.get("chassis")!.options.bakeId).toEqual(expect.any(String));
    expect(current.registry.get("pad")!.options.bakeId).toBeUndefined();
    expect(current.debugState().bakeBoundaryCount).toBe(1);
    expect(current.debugState().bakedSurfaceCount).toBe(1);
    expect(current.debugState().dynamicSurfaceCount).toBe(1);

    // The imperative handle invalidates exactly its boundary; the rebake is
    // coalesced into the scheduled update (the sync scheduler runs it inside
    // the invalidate call) and returns to the retained state.
    bakeRef.current!.invalidate();
    expect(current.debugState().lastRebakeSurfaceCount).toBe(1);
    expect(current.registry.get("chassis")!.dirty).toBe(false);
    expect(current.debugState().bakedSurfaceCount).toBe(1);
  });

  it("ordinary unrelated DOM mutations re-measure dynamic surfaces only", async () => {
    stubElementRects();
    stubCanvas2d();
    let layer: UkiboriDom | null = null;
    const chassisRef = createRef<HTMLDivElement>();
    const padRef = createRef<HTMLDivElement>();
    render(
      <Ukibori schedule={(cb) => cb()} onReady={(l) => (layer = l)}>
        <Bake>
          <Surface ref={chassisRef} sceneId="chassis" elevation={0} thickness={2}>
            chassis
          </Surface>
        </Bake>
        <Surface ref={padRef} sceneId="pad" elevation={4} thickness={2}>
          pad
        </Surface>
      </Ukibori>,
    );
    await flushAsync();
    const current = layer!;
    const chassisSpy = countRects(chassisRef.current!);
    const padSpy = countRects(padRef.current!);

    // An unrelated mutation OUTSIDE the Ukibori tree: the conservative
    // document observer invalidates the dynamic surface; the baked surface
    // is retained with ZERO additional DOM measurements.
    document.body.setAttribute("data-unrelated", "mutation");
    await flushAsync();
    expect(padSpy.mock.calls.length).toBeGreaterThan(0);
    expect(chassisSpy.mock.calls.length).toBe(0);
    expect(current.registry.get("chassis")!.dirty).toBe(false);
  });

  it("explicit invalidate() re-measures the baked subtree", async () => {
    stubElementRects();
    stubCanvas2d();
    let layer: UkiboriDom | null = null;
    const bakeRef = createRef<BakeHandle>();
    const chassisRef = createRef<HTMLDivElement>();
    render(
      <Ukibori schedule={(cb) => cb()} onReady={(l) => (layer = l)}>
        <Bake ref={bakeRef}>
          <Surface ref={chassisRef} sceneId="chassis" elevation={0} thickness={2}>
            chassis
          </Surface>
        </Bake>
      </Ukibori>,
    );
    await flushAsync();
    const current = layer!;
    const chassisSpy = countRects(chassisRef.current!);
    expect(chassisSpy.mock.calls.length).toBe(0);

    bakeRef.current!.invalidate();
    await flushAsync();
    expect(chassisSpy.mock.calls.length).toBe(1);
    expect(current.debugState().lastRebakeSurfaceCount).toBe(1);

    // Steady state after the rebake: retained fast path (no measurements).
    document.body.setAttribute("data-unrelated", "again");
    await flushAsync();
    expect(chassisSpy.mock.calls.length).toBe(1);
  });

  it("nested boundaries: a surface belongs to the NEAREST enclosing Bake", async () => {
    stubElementRects();
    stubCanvas2d();
    let layer: UkiboriDom | null = null;
    const outerRef = createRef<BakeHandle>();
    const innerRef = createRef<BakeHandle>();
    const innerRef2 = createRef<HTMLDivElement>();
    render(
      <Ukibori schedule={(cb) => cb()} onReady={(l) => (layer = l)}>
        <Bake ref={outerRef}>
          <Surface sceneId="outer-static" elevation={0} thickness={2}>
            outer
          </Surface>
          <Bake ref={innerRef}>
            <Surface ref={innerRef2} sceneId="inner-static" elevation={1} thickness={2}>
              inner
            </Surface>
          </Bake>
        </Bake>
      </Ukibori>,
    );
    await flushAsync();
    const current = layer!;
    const outerBakeId = current.registry.get("outer-static")!.options.bakeId;
    const innerBakeId = current.registry.get("inner-static")!.options.bakeId;
    expect(outerBakeId).toEqual(expect.any(String));
    expect(innerBakeId).toEqual(expect.any(String));
    expect(innerBakeId).not.toBe(outerBakeId);
    expect(current.debugState().bakeBoundaryCount).toBe(2);

    // The outer handle invalidates only the OUTER boundary's surfaces.
    const innerSpy = countRects(innerRef2.current!);
    outerRef.current!.invalidate();
    await flushAsync();
    expect(innerSpy.mock.calls.length).toBe(0);
    expect(current.debugState().lastRebakeSurfaceCount).toBe(1);

    // ...and the inner handle only the inner one.
    innerRef.current!.invalidate();
    await flushAsync();
    expect(innerSpy.mock.calls.length).toBe(1);
  });

  it("provider-less / SSR: plain DOM children and a safe no-op invalidate()", () => {
    const bakeRef = createRef<BakeHandle>();
    render(
      <Bake ref={bakeRef}>
        <p>static content</p>
      </Bake>,
    );
    expect(document.querySelector("p")?.textContent).toBe("static content");
    // No physical layer yet (hydration pending): the handle must be safe.
    expect(() => bakeRef.current!.invalidate()).not.toThrow();
  });
});

import { act, createRef, useContext, useLayoutEffect } from "react";
import type { RefObject } from "react";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stubCanvas2d, stubElementRects } from "../test/dom";
import { Bake, Surface, Ukibori } from "../index";
import type { BakeHandle } from "../index";
import { BakeContext, UkiboriContext } from "../context";
import { UkiboriDom } from "ukibori-dom";

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

function InvalidateOnLayout({ handle, revision }: { handle: { current: BakeHandle | null }; revision: number }) {
  useLayoutEffect(() => {
    if (revision > 0) {
      handle.current?.invalidate();
    }
  }, [handle, revision]);
  return null;
}

/** Keep one inner Bake mounted while its explicit parent context changes. */
function ReparentedBake({
  parent,
  innerRef,
}: {
  parent: "a" | "b";
  innerRef: RefObject<BakeHandle | null>;
}) {
  const enclosing = useContext(BakeContext);
  const parentBoundary =
    parent === "b"
      ? enclosing
      : { id: "a-boundary", parentId: null };
  return (
    <BakeContext.Provider value={parentBoundary}>
      <Bake ref={innerRef}>
        <Surface sceneId="reparented-inner" elevation={1} thickness={2}>
          inner
        </Surface>
      </Bake>
    </BakeContext.Provider>
  );
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

  it("nested boundaries: nearest ownership + outer invalidate CASCADES into descendants", async () => {
    stubElementRects();
    stubCanvas2d();
    let layer: UkiboriDom | null = null;
    const outerRef = createRef<BakeHandle>();
    const innerRef = createRef<BakeHandle>();
    const outerSurfaceRef = createRef<HTMLDivElement>();
    const innerSurfaceRef = createRef<HTMLDivElement>();
    render(
      <Ukibori schedule={(cb) => cb()} onReady={(l) => (layer = l)}>
        <Bake ref={outerRef}>
          <Surface ref={outerSurfaceRef} sceneId="outer-static" elevation={0} thickness={2}>
            outer
          </Surface>
          <Bake ref={innerRef}>
            <Surface ref={innerSurfaceRef} sceneId="inner-static" elevation={1} thickness={2}>
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
    // Ownership still resolves to the NEAREST enclosing boundary.
    expect(innerBakeId).not.toBe(outerBakeId);
    expect(current.debugState().bakeBoundaryCount).toBe(2);

    const outerSpy = countRects(outerSurfaceRef.current!);
    const innerSpy = countRects(innerSurfaceRef.current!);

    // OUTER invalidate: the outer subtree's layout can reposition its nested
    // boundaries, so the whole physical subtree (outer + inner) is rebaked.
    outerRef.current!.invalidate();
    await flushAsync();
    expect(outerSpy.mock.calls.length).toBe(1);
    expect(innerSpy.mock.calls.length).toBe(1);
    expect(current.debugState().lastRebakeSurfaceCount).toBe(2);

    // INNER invalidate: never cascades upward.
    innerRef.current!.invalidate();
    await flushAsync();
    expect(innerSpy.mock.calls.length).toBe(2);
    expect(outerSpy.mock.calls.length).toBe(1);
    expect(current.debugState().lastRebakeSurfaceCount).toBe(1);
  });

  it("publishes a reparented Bake hierarchy before a same-commit layout invalidate", async () => {
    stubElementRects();
    stubCanvas2d();
    const layer = new UkiboriDom({
      schedule: (cb) => cb(),
      observe: false,
    });
    layer.registerBake("a-boundary");
    const outerRef = createRef<BakeHandle>();
    const innerRef = createRef<BakeHandle>();
    const context = {
      mode: "physical" as const,
      layer,
      backend: "cpu" as const,
      reportError: vi.fn(),
      light: { x: 0, y: 0, z: 1 },
      intensity: 1,
      color: "#fff",
    };
    function Tree({ parent, revision }: { parent: "a" | "b"; revision: number }) {
      return (
        <UkiboriContext.Provider value={context}>
          <Bake ref={outerRef}>
            <ReparentedBake parent={parent} innerRef={innerRef} />
          </Bake>
          <InvalidateOnLayout handle={outerRef} revision={revision} />
        </UkiboriContext.Provider>
      );
    }

    const { rerender } = render(<Tree parent="a" revision={0} />);
    await flushAsync();
    // Use its retained registry entry to obtain the element and count its
    // measurements.
    const registered = layer.registry.get("reparented-inner")!.element;
    const innerSpy = countRects(registered);
    const before = innerSpy.mock.calls.length;

    // The inner Bake remains mounted but changes from A's context to B's.
    // Its layout effect updates the parent map before B's consumer effect
    // calls the outer handle in the same commit.
    rerender(<Tree parent="b" revision={1} />);
    await flushAsync();
    expect(innerSpy.mock.calls.length).toBe(before + 1);

    // A's old tree no longer reaches the reparented inner boundary.
    layer.invalidateBake("a-boundary");
    expect(innerSpy.mock.calls.length).toBe(before + 1);
    layer.dispose();
  });

  it("unmounting a nested boundary removes its cascade reach without stale ownership", async () => {
    stubElementRects();
    stubCanvas2d();
    let layer: UkiboriDom | null = null;
    const outerRef = createRef<BakeHandle>();
    const { rerender } = render(
      <Ukibori schedule={(cb) => cb()} onReady={(l) => (layer = l)}>
        <Bake ref={outerRef}>
          <Surface sceneId="outer-static" elevation={0} thickness={2}>
            outer
          </Surface>
          <Bake>
            <Surface sceneId="inner-static" elevation={1} thickness={2}>
              inner
            </Surface>
          </Bake>
        </Bake>
      </Ukibori>,
    );
    await flushAsync();
    const current = layer!;
    expect(current.registry.has("inner-static")).toBe(true);

    // The inner <Bake> unmounts: its registration is removed with it.
    rerender(
      <Ukibori schedule={(cb) => cb()} onReady={(l) => (layer = l)}>
        <Bake ref={outerRef}>
          <Surface sceneId="outer-static" elevation={0} thickness={2}>
            outer
          </Surface>
        </Bake>
      </Ukibori>,
    );
    await flushAsync();
    expect(current.registry.has("inner-static")).toBe(false);

    // A late invalidate for the unmounted boundary is a safe no-op; the
    // outer boundary still rebakes cleanly.
    expect(() => current.invalidateBake("gone-boundary")).not.toThrow();
    outerRef.current!.invalidate();
    await flushAsync();
    expect(current.debugState().lastRebakeSurfaceCount).toBe(1);
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

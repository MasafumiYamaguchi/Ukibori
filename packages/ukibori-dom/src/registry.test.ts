import { describe, expect, it } from "vitest";
import { SurfaceRegistry, assertValidId } from "./registry";
import type { SurfaceEntry } from "./registry";

function makeElement(): HTMLElement {
  return document.createElement("div");
}

function entry(id: string, el: HTMLElement): SurfaceEntry {
  return {
    id,
    element: el,
    options: {
      id,
      shape: { kind: "roundedRect", radius: 4 } as const,
      elevation: 0,
      thickness: 1,
      material: "silicone",
    },
    geometry: null,
    dirty: true,
    inkDelegated: false,
  };
}

describe("SurfaceRegistry", () => {
  it("tracks register / lookup / remove by id and element", () => {
    const registry = new SurfaceRegistry();
    const el = makeElement();
    registry.add(entry("a", el));
    expect(registry.size).toBe(1);
    expect(registry.get("a")?.element).toBe(el);
    expect(registry.idFor(el)).toBe("a");
    registry.remove("a");
    expect(registry.size).toBe(0);
    expect(registry.get("a")).toBeUndefined();
    expect(registry.idFor(el)).toBeUndefined();
  });

  it("throws on duplicate ids and duplicate elements", () => {
    const registry = new SurfaceRegistry();
    const elA = makeElement();
    const elB = makeElement();
    registry.add(entry("a", elA));
    expect(() => registry.add(entry("a", elB))).toThrow(TypeError);
    expect(() => registry.add(entry("b", elA))).toThrow(TypeError);
  });

  it("tracks node-level dirty state", () => {
    const registry = new SurfaceRegistry();
    const el = makeElement();
    registry.add(entry("a", el));
    registry.markDirty("a");
    expect(registry.hasDirtyNodes()).toBe(true);
    expect(registry.dirtyCount()).toBe(1);
    registry.clearDirty();
    expect(registry.hasDirtyNodes()).toBe(false);
    expect(registry.dirtyCount()).toBe(0);
    expect(registry.markDirty("missing")).toBeUndefined();
  });

  it("marks every node dirty", () => {
    const registry = new SurfaceRegistry();
    registry.add(entry("a", makeElement()));
    registry.add(entry("b", makeElement()));
    registry.clearDirty();
    registry.markAllDirty();
    expect(registry.dirtyCount()).toBe(2);
  });

  it("exposes measured boxes in insertion order", () => {
    const registry = new SurfaceRegistry();
    const a = entry("a", makeElement());
    a.geometry = { x: 1, y: 2, w: 10, h: 10, radius: 0 };
    const b = entry("b", makeElement());
    b.geometry = { x: 50, y: 60, w: 20, h: 20, radius: 2 };
    registry.add(a);
    registry.add(b);
    registry.add(entry("c", makeElement()));
    expect(registry.measuredBoxes()).toEqual([
      { x: 1, y: 2, w: 10, h: 10 },
      { x: 50, y: 60, w: 20, h: 20 },
    ]);
  });

  it("clears everything", () => {
    const registry = new SurfaceRegistry();
    registry.add(entry("a", makeElement()));
    registry.add(entry("b", makeElement()));
    registry.clear();
    expect(registry.size).toBe(0);
  });

  describe("#59 bake boundary", () => {
    function bakedEntry(id: string, bakeId: string): SurfaceEntry {
      const e = entry(id, makeElement());
      e.options = { ...e.options, bakeId };
      // A baked entry has been measured at least once.
      e.geometry = { x: 1, y: 2, w: 10, h: 10, radius: 0 };
      e.dirty = false;
      return e;
    }

    it("markAllDirty retains baked surfaces unless forced", () => {
      const registry = new SurfaceRegistry();
      registry.add(bakedEntry("baked", "static"));
      const dynamic = entry("dyn", makeElement());
      registry.add(dynamic);
      registry.clearDirty();

      // Ordinary (conservative) invalidation: the measured baked surface is
      // skipped, the dynamic surface is marked.
      registry.markAllDirty();
      expect(registry.get("baked")!.dirty).toBe(false);
      expect(registry.get("dyn")!.dirty).toBe(true);

      // Forced invalidation includes baked surfaces.
      registry.clearDirty();
      registry.markAllDirty(true);
      expect(registry.get("baked")!.dirty).toBe(true);
      expect(registry.get("dyn")!.dirty).toBe(true);
    });

    it("an unmeasured or already-dirty bake entry is never skipped", () => {
      const registry = new SurfaceRegistry();
      // Unmeasured: geometry null -> must be measured regardless.
      const unmeasured = entry("unmeasured", makeElement());
      unmeasured.options = { ...unmeasured.options, bakeId: "static" };
      registry.add(unmeasured);
      registry.clearDirty();
      registry.markAllDirty();
      expect(registry.get("unmeasured")!.dirty).toBe(true);
    });

    it("markBakeDirty touches only the named boundary", () => {
      const registry = new SurfaceRegistry();
      registry.add(bakedEntry("a", "boundary-a"));
      registry.add(bakedEntry("b", "boundary-b"));
      registry.add(entry("dyn", makeElement()));
      registry.clearDirty();
      registry.markBakeDirty("boundary-a");
      expect(registry.get("a")!.dirty).toBe(true);
      expect(registry.get("b")!.dirty).toBe(false);
      expect(registry.get("dyn")!.dirty).toBe(false);
    });

    it("reports bake boundary / baked / dynamic surface counts", () => {
      const registry = new SurfaceRegistry();
      registry.add(bakedEntry("a", "one"));
      registry.add(bakedEntry("b", "two"));
      const dirtyBaked = bakedEntry("c", "one");
      dirtyBaked.dirty = true;
      registry.add(dirtyBaked);
      registry.add(entry("dyn", makeElement()));
      expect(registry.bakeBoundaryCount()).toBe(2);
      expect(registry.bakedSurfaceCount()).toBe(2);
      expect(registry.dynamicSurfaceCount()).toBe(1);
    });
  });
});

describe("assertValidId", () => {
  it("accepts renderer-style ids", () => {
    expect(() => assertValidId("primary")).not.toThrow();
    expect(() => assertValidId("a-b_c.1")).not.toThrow();
    // The renderer's #13 rule is only "non-empty string"; nothing stricter.
    expect(() => assertValidId("a b")).not.toThrow();
  });

  it("rejects empty and non-string ids", () => {
    expect(() => assertValidId("")).toThrow(TypeError);
  });
});


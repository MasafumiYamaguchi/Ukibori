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
    savedStyles: [],
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

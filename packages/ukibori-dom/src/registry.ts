import type { DomSurfaceOptions, MeasuredGeometry } from "./types";

/**
 * Retained DOM registry (#20).
 *
 * Holds a reference to every registered element plus its cached measured
 * geometry and dirty state. The layer NEVER rescans the document: updates are
 * push-based (register/unregister calls and observer-driven `markDirty`), and
 * rendering only re-measures dirty nodes.
 */

export interface SurfaceEntry {
  id: string;
  element: HTMLElement;
  options: DomSurfaceOptions;
  /** last measured geometry (null until first measure) */
  geometry: MeasuredGeometry | null;
  dirty: boolean;
  /**
   * #52 compositing policy state: whether THIS layer currently owns the
   * `data-ukibori-physical-ink` suppression for the element. Edge-triggered
   * (set on the false->true delegation transition, cleared on the
   * true->false transition), so retained property updates never multiply the
   * attribute ownership refcount — the refcount tracks "who owns the
   * attribute now", not how many times an option changed.
   */
  inkDelegated: boolean;
}

/**
 * #59 bake boundary state: a surface is in the RETAINED BAKED state when it
 * belongs to a bake boundary (`options.bakeId`) and its geometry has been
 * measured at least once (`geometry !== null`). Such a surface is excluded
 * from the conservative `markAllDirty` (document MutationObserver / scroll)
 * and stays on its cached geometry until it is explicitly invalidated
 * (`invalidateBake`), actually changes layout (ResizeObserver), gets an
 * option update, or a forced invalidation runs (window resize / font load /
 * `invalidate()`).
 */
export function isBaked(entry: SurfaceEntry): boolean {
  return entry.options.bakeId !== undefined && entry.geometry !== null;
}

export class SurfaceRegistry {
  private readonly byId = new Map<string, SurfaceEntry>();
  private readonly byElement = new Map<Element, string>();

  get size(): number {
    return this.byId.size;
  }

  get(id: string): SurfaceEntry | undefined {
    return this.byId.get(id);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  idFor(element: Element): string | undefined {
    return this.byElement.get(element);
  }

  /** All registered entries in insertion order. */
  entries(): SurfaceEntry[] {
    return [...this.byId.values()];
  }

  /**
   * Register a new surface. Throws on duplicate ids (renderer #13 policy) or
   * when the element is already registered.
   */
  add(entry: SurfaceEntry): void {
    if (this.byId.has(entry.id)) {
      throw new TypeError(`duplicate surface id "${entry.id}"`);
    }
    if (this.byElement.has(entry.element)) {
      throw new TypeError(`element already registered as "${this.byElement.get(entry.element)}"`);
    }
    this.byId.set(entry.id, entry);
    this.byElement.set(entry.element, entry.id);
  }

  /** Remove a surface. Returns the removed entry (or undefined). */
  remove(id: string): SurfaceEntry | undefined {
    const entry = this.byId.get(id);
    if (entry === undefined) {
      return undefined;
    }
    this.byId.delete(id);
    this.byElement.delete(entry.element);
    return entry;
  }

  /** Remove every entry (dispose path). */
  clear(): void {
    this.byId.clear();
    this.byElement.clear();
  }

  markDirty(id: string): void {
    const entry = this.byId.get(id);
    if (entry !== undefined) {
      entry.dirty = true;
    }
  }

  /**
   * Mark every entry dirty. #59 bake policy: surfaces in the retained baked
   * state (`isBaked`) are SKIPPED unless `includeBaked` is set — an ordinary
   * unrelated DOM mutation must not re-measure a baked subtree. Forced
   * invalidations (viewport resize, font load, explicit `invalidate()`) pass
   * `includeBaked = true` because they can move/resize any element
   * (stale-geometry protection).
   */
  markAllDirty(includeBaked = false): void {
    for (const entry of this.byId.values()) {
      if (!includeBaked && isBaked(entry)) {
        continue;
      }
      entry.dirty = true;
    }
  }

  /** Mark every surface belonging to the #59 bake boundary `bakeId` dirty
   * (coalescing happens through the shared scheduled render). */
  markBakeDirty(bakeId: string): void {
    for (const entry of this.byId.values()) {
      if (entry.options.bakeId === bakeId) {
        entry.dirty = true;
      }
    }
  }

  hasDirtyNodes(): boolean {
    for (const entry of this.byId.values()) {
      if (entry.dirty) {
        return true;
      }
    }
    return false;
  }

  dirtyCount(): number {
    let count = 0;
    for (const entry of this.byId.values()) {
      if (entry.dirty) {
        count++;
      }
    }
    return count;
  }

  clearDirty(): void {
    for (const entry of this.byId.values()) {
      entry.dirty = false;
    }
  }

  /** All measured geometries (document CSS px), skipping unmeasured entries. */
  measuredBoxes(): Array<{ x: number; y: number; w: number; h: number }> {
    const out: Array<{ x: number; y: number; w: number; h: number }> = [];
    for (const entry of this.byId.values()) {
      if (entry.geometry !== null) {
        out.push({ x: entry.geometry.x, y: entry.geometry.y, w: entry.geometry.w, h: entry.geometry.h });
      }
    }
    return out;
  }

  /** #59: number of distinct bake boundaries among registered surfaces. */
  bakeBoundaryCount(): number {
    const ids = new Set<string>();
    for (const entry of this.byId.values()) {
      if (entry.options.bakeId !== undefined) {
        ids.add(entry.options.bakeId);
      }
    }
    return ids.size;
  }

  /** #59: surfaces currently in the retained baked state (bake boundary +
   * measured geometry + not dirty). */
  bakedSurfaceCount(): number {
    let count = 0;
    for (const entry of this.byId.values()) {
      if (isBaked(entry) && !entry.dirty) {
        count++;
      }
    }
    return count;
  }

  /** #59: surfaces that do NOT belong to any bake boundary (always subject to
   * the ordinary conservative invalidation semantics). */
  dynamicSurfaceCount(): number {
    let count = 0;
    for (const entry of this.byId.values()) {
      if (entry.options.bakeId === undefined) {
        count++;
      }
    }
    return count;
  }
}

/** Validate a surface id against the renderer #13 rules (non-empty string). */
export function assertValidId(id: string): void {
  if (typeof id !== "string" || id.length === 0) {
    throw new TypeError("surface id must be a non-empty string");
  }
}

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

  markAllDirty(): void {
    for (const entry of this.byId.values()) {
      entry.dirty = true;
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
}

/** Validate a surface id against the renderer #13 rules (non-empty string). */
export function assertValidId(id: string): void {
  if (typeof id !== "string" || id.length === 0) {
    throw new TypeError("surface id must be a non-empty string");
  }
}

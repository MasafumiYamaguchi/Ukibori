import {
  DEFAULT_LIGHT_DIRECTION,
  composeSdfHeightField,
  lightScene,
  normalizeVec3,
} from "ukibori-renderer";
import type { HostBuffer, LightingBuffers, Material } from "ukibori-renderer";
import { computeRegion, sanitizeDpr } from "./coords";
import { compositeSurfaceImage } from "./compositor";
import { geometriesEqual, measureSurfaceElement } from "./measure";
import { OverlayCanvas, applySuppression, restoreSavedStyles } from "./overlay";
import type { Overlay } from "./overlay";
import { SurfaceRegistry, assertValidId } from "./registry";
import { buildScene } from "./scene-builder";
import type {
  CompositeOptions,
  DomDebugState,
  DomLightState,
  DomShadowOptions,
  DomSurfaceOptions,
} from "./types";

/**
 * UkiboriDom — the DOM integration layer (#20).
 *
 * Owns the retained DOM registry, the renderer scene, the non-interactive
 * overlay canvas and the invalidation observers. The browser DOM stays
 * authoritative for layout / semantics / accessibility / text / forms /
 * focus / pointer & keyboard interaction; UkiboriDom only adds the physical
 * rendering layer and never replaces the DOM it observes.
 *
 * Synchronization model (no whole-document rescan, no per-frame rescan):
 *
 * - register/unregister: retained scene nodes are added/removed (mount /
 *   unmount)
 * - ResizeObserver: a registered element's layout changed -> node dirty
 * - MutationObserver: a registered element's style/class/subtree changed
 *   (incl. text geometry) -> node dirty
 * - scroll (capture): node dirty, re-measured on the next render; with
 *   document-relative scene coordinates ordinary page scroll leaves geometry
 *   unchanged and the render is skipped
 * - viewport resize: node dirty + scene dirty (devicePixelRatio may have
 *   changed)
 * - font load (`document.fonts` loadingdone): node dirty + scene dirty
 * - light / intensity / materials updates: scene dirty
 *
 * All invalidation coalesces through a single rAF-throttled `render()`.
 */

export interface UkiboriDomOptions {
  light?: Partial<DomLightState>;
  /** material overrides keyed by ref; built-in presets fill the gaps */
  materials?: Record<string, Material>;
  /** cast-shadow pass options forwarded to the renderer (#17) */
  shadow?: DomShadowOptions;
  /** compositor mapping (translucent shadows on the base plane) */
  compositing?: CompositeOptions;
  /** scene-region margin reserved for cast shadows (CSS px, default 64) */
  margin?: number;
  /** fixed device-pixel-ratio, or a provider; default `window.devicePixelRatio` */
  dpr?: number | (() => number);
  overlay?: {
    /** host the overlay canvas is inserted into (default `document.body`) */
    host?: Element;
    /** overlay z-index (default 0; surfaces must paint above it) */
    zIndex?: number;
    /** test seam: supply a fake overlay instead of a real canvas */
    factory?: () => Overlay;
  };
  /** scheduler for the render loop (default `requestAnimationFrame`) */
  schedule?: (cb: () => void) => void;
  /** error reporter (default `console.error`); render failures do not throw */
  onError?: (error: unknown) => void;
  /** wire DOM observers (default true; disable for controlled tests) */
  observe?: boolean;
}

const DEFAULT_MARGIN = 64;
const DEFAULT_INTENSITY = 1;

const MUTATION_CONFIG: MutationObserverInit = {
  attributes: true,
  attributeFilter: ["style", "class"],
  childList: true,
  subtree: true,
  characterData: true,
};

export class UkiboriDom {
  readonly registry: SurfaceRegistry;
  private readonly overlay: Overlay;
  private readonly scheduler: (cb: () => void) => void;
  private readonly onError: (error: unknown) => void;
  private readonly margin: number;
  private dprSource: number | (() => number) | undefined;
  private readonly compositeOptions: CompositeOptions;
  private readonly shadowOptions: DomShadowOptions;

  private light: DomLightState;
  private materials: Record<string, Material> | undefined;

  private readonly resizeObserver: ResizeObserver | null;
  private readonly mutationObserver: MutationObserver | null;

  private renderScheduled = false;
  private disposed = false;
  private sceneDirty = true;
  private forceRender = true;

  private lastRegion: { x: number; y: number; w: number; h: number } | null = null;
  private lastDpr = 1;
  private lastRenderSize: { width: number; height: number } | null = null;
  private lastRenderMs = 0;
  private lastBuffers: LightingBuffers | null = null;
  private lastObjectId: HostBuffer | null = null;

  constructor(options: UkiboriDomOptions = {}) {
    this.registry = new SurfaceRegistry();
    this.scheduler = options.schedule ?? defaultScheduler;
    this.onError = options.onError ?? ((error) => console.error(error));
    const margin = options.margin;
    this.margin =
      typeof margin === "number" && Number.isFinite(margin) && margin >= 0
        ? margin
        : DEFAULT_MARGIN;
    this.dprSource = options.dpr;
    this.compositeOptions = options.compositing ?? {};
    this.shadowOptions = options.shadow ?? {};
    this.light = {
      direction: normalizeVec3(
        options.light?.direction ?? DEFAULT_LIGHT_DIRECTION,
        DEFAULT_LIGHT_DIRECTION,
      ),
      intensity:
        Number.isFinite(options.light?.intensity) && (options.light?.intensity ?? 0) >= 0
          ? (options.light?.intensity ?? DEFAULT_INTENSITY)
          : DEFAULT_INTENSITY,
    };
    this.materials = options.materials;
    this.overlay =
      options.overlay?.factory !== undefined
        ? options.overlay.factory()
        : new OverlayCanvas(options.overlay?.host ?? document.body, options.overlay?.zIndex ?? 0);

    this.resizeObserver =
      typeof ResizeObserver === "function"
        ? new ResizeObserver((entries) => {
            let changed = false;
            for (const entry of entries) {
              const id = this.registry.idFor(entry.target);
              if (id !== undefined) {
                this.registry.markDirty(id);
                changed = true;
              }
            }
            if (changed) {
              this.scheduleRender();
            }
          })
        : null;

    this.mutationObserver =
      typeof MutationObserver === "function"
        ? new MutationObserver((mutations) => {
            let changed = false;
            for (const mutation of mutations) {
              const id = this.surfaceIdForNode(mutation.target);
              if (id !== undefined) {
                this.registry.markDirty(id);
                changed = true;
              }
            }
            if (changed) {
              this.scheduleRender();
            }
          })
        : null;

    if (options.observe !== false) {
      if (typeof window !== "undefined") {
        window.addEventListener("resize", this.onViewportChange);
      }
      if (typeof document !== "undefined") {
        document.addEventListener("scroll", this.onScroll, true);
        const fonts = document.fonts;
        fonts?.addEventListener?.("loadingdone", this.onFontsLoaded);
      }
    }
  }

  /**
   * Register a DOM element as a Ukibori surface (mount). The element's own
   * background/shadow are suppressed inline and restored on `unregister`.
   */
  register(element: HTMLElement, options: DomSurfaceOptions): void {
    this.throwIfDisposed();
    assertValidId(options.id);
    const savedStyles = applySuppression(element);
    const entry = {
      id: options.id,
      element,
      options: { ...options },
      geometry: null,
      dirty: true,
      savedStyles,
    };
    this.registry.add(entry);
    this.resizeObserver?.observe(element);
    this.mutationObserver?.observe(element, MUTATION_CONFIG);
    this.sceneDirty = true;
    this.scheduleRender();
  }

  /** Remove a registered surface (unmount) and restore its inline styles. */
  unregister(id: string): void {
    this.throwIfDisposed();
    const entry = this.registry.remove(id);
    if (entry === undefined) {
      return;
    }
    this.resizeObserver?.unobserve(entry.element);
    // MutationObserver has no per-node unobserve: re-observe the survivors.
    this.reobserveMutations();
    restoreSavedStyles(entry.element, entry.savedStyles);
    this.sceneDirty = true;
    this.scheduleRender();
  }

  /** Merge a patch into a surface's options and invalidate it. */
  updateSurface(id: string, patch: Partial<DomSurfaceOptions>): void {
    this.throwIfDisposed();
    const entry = this.registry.get(id);
    if (entry === undefined) {
      return;
    }
    entry.options = { ...entry.options, ...patch };
    // Any option change feeds the scene (geometry, elevation, material...).
    this.sceneDirty = true;
    this.registry.markDirty(id);
    this.scheduleRender();
  }

  /** Change the shared light. `direction` is normalized; invalid -> +z. */
  setLight(direction: { x: number; y: number; z: number }, intensity?: number): void {
    this.throwIfDisposed();
    this.light.direction = normalizeVec3(direction, DEFAULT_LIGHT_DIRECTION);
    if (intensity !== undefined) {
      this.light.intensity =
        Number.isFinite(intensity) && intensity >= 0 ? intensity : DEFAULT_INTENSITY;
    }
    this.sceneDirty = true;
    this.scheduleRender();
  }

  setIntensity(intensity: number): void {
    this.throwIfDisposed();
    this.light.intensity =
      Number.isFinite(intensity) && intensity >= 0 ? intensity : DEFAULT_INTENSITY;
    this.sceneDirty = true;
    this.scheduleRender();
  }

  /** Replace the material override table (presets still resolve). */
  setMaterials(materials: Record<string, Material>): void {
    this.throwIfDisposed();
    this.materials = materials;
    this.sceneDirty = true;
    this.scheduleRender();
  }

  /** Replace the cast-shadow pass options (#17). */
  setShadow(options: DomShadowOptions): void {
    this.throwIfDisposed();
    Object.assign(this.shadowOptions, options);
    this.sceneDirty = true;
    this.scheduleRender();
  }

  /** Replace the render-target dpr source (e.g. on a zoom / display change). */
  setDpr(dpr: number | (() => number)): void {
    this.throwIfDisposed();
    this.dprSource = dpr;
    this.sceneDirty = true;
    this.scheduleRender();
  }

  /**
   * Force re-measure of one surface (or all when `id` is omitted). Font/text
   * geometry changes should be followed by `updateSurface(id, { shape })`
   * with a fresh mask and/or `invalidate(id)`.
   */
  invalidate(id?: string): void {
    this.throwIfDisposed();
    if (id !== undefined) {
      this.registry.markDirty(id);
    } else {
      this.registry.markAllDirty();
    }
    this.scheduleRender();
  }

  /** Schedule a render; coalesces multiple invalidations into one pass. */
  scheduleRender(): void {
    if (this.disposed || this.renderScheduled) {
      return;
    }
    this.renderScheduled = true;
    this.scheduler(() => {
      this.renderScheduled = false;
      this.render();
    });
  }

  /**
   * Synchronous retained render: re-measure dirty nodes, skip when nothing
   * changed, otherwise rebuild the scene (geometry + light + DPR), render via
   * the CPU backend and composite onto the overlay.
   */
  render(): void {
    if (this.disposed) {
      return;
    }
    const startedAt = performance.now();

    let geometryChanged = false;
    for (const entry of this.registry.entries()) {
      if (entry.dirty || entry.geometry === null) {
        entry.dirty = false;
        let geometry;
        try {
          geometry = measureSurfaceElement(entry.element, entry.options);
        } catch (error) {
          this.onError(error);
          continue;
        }
        if (!geometriesEqual(geometry, entry.geometry)) {
          entry.geometry = geometry;
          geometryChanged = true;
        }
      }
    }

    if (
      this.lastRegion !== null &&
      !geometryChanged &&
      !this.sceneDirty &&
      !this.forceRender
    ) {
      this.lastRenderMs = performance.now() - startedAt;
      return;
    }
    this.forceRender = false;

    const region = computeRegion(this.registry.measuredBoxes(), this.margin);
    if (region === null) {
      this.overlay.clear();
      this.lastRegion = null;
      this.lastRenderSize = null;
      this.lastBuffers = null;
      this.lastObjectId = null;
      this.sceneDirty = false;
      this.lastRenderMs = performance.now() - startedAt;
      return;
    }

    const dpr = this.currentDpr();
    let scene: ReturnType<typeof buildScene>;
    let buffers: LightingBuffers;
    try {
      scene = buildScene({
        registry: this.registry,
        region,
        dpr,
        light: this.light,
        materials: this.materials,
      });
      // Compose the height field once for the ownership buffer (#18 objectId);
      // `lightScene` re-runs the same composition internally for its shading
      // passes, so the two are guaranteed consistent. This CPU double-compose
      // is the reference implementation cost; a backend (#21) can merge them.
      const composed = composeSdfHeightField(scene);
      buffers = lightScene(scene, { shadow: this.shadowOptions });
      this.lastObjectId = composed.objectId;
    } catch (error) {
      this.onError(error);
      this.lastRenderMs = performance.now() - startedAt;
      return;
    }

    const image = compositeSurfaceImage(
      {
        color: buffers.color,
        objectId: this.lastObjectId!,
        visibility: buffers.visibility ?? null,
      },
      this.compositeOptions,
    );

    this.overlay.resizeAndPosition(region, dpr);
    this.overlay.paint(image);

    this.lastRegion = region;
    this.lastDpr = dpr;
    this.lastRenderSize = { width: image.width, height: image.height };
    this.lastBuffers = buffers;
    this.sceneDirty = false;
    this.lastRenderMs = performance.now() - startedAt;
  }

  /** Intermediate renderer buffers from the last render (debug views). */
  debugBuffers(): LightingBuffers | null {
    return this.lastBuffers;
  }

  /** Owning-surface buffer (#18 objectId) from the last render (debug views). */
  debugObjectId(): HostBuffer | null {
    return this.lastObjectId;
  }

  debugState(): DomDebugState {
    return {
      nodeCount: this.registry.size,
      dirtyCount: this.registry.dirtyCount(),
      region: this.lastRegion === null ? null : { ...this.lastRegion },
      dpr: this.lastDpr,
      lastRenderMs: this.lastRenderMs,
      renderSize: this.lastRenderSize === null ? null : { ...this.lastRenderSize },
    };
  }

  /** Remove the overlay, disconnect observers and restore all surface styles. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (typeof window !== "undefined") {
      window.removeEventListener("resize", this.onViewportChange);
    }
    if (typeof document !== "undefined") {
      document.removeEventListener("scroll", this.onScroll, true);
      document.fonts?.removeEventListener?.("loadingdone", this.onFontsLoaded);
    }
    this.resizeObserver?.disconnect();
    this.mutationObserver?.disconnect();
    for (const entry of this.registry.entries()) {
      restoreSavedStyles(entry.element, entry.savedStyles);
    }
    this.registry.clear();
    this.overlay.dispose();
  }

  private currentDpr(): number {
    const source = this.dprSource;
    const value = typeof source === "function" ? source() : source;
    const win = typeof window !== "undefined" ? window : undefined;
    return sanitizeDpr(value ?? win?.devicePixelRatio ?? 1);
  }

  private surfaceIdForNode(node: Node): string | undefined {
    const start = node instanceof Element ? node : node.parentElement;
    let current: Element | null = start;
    while (current !== null) {
      const id = this.registry.idFor(current);
      if (id !== undefined) {
        return id;
      }
      current = current.parentElement;
    }
    return undefined;
  }

  private reobserveMutations(): void {
    if (this.mutationObserver === null) {
      return;
    }
    this.mutationObserver.disconnect();
    for (const entry of this.registry.entries()) {
      this.mutationObserver.observe(entry.element, MUTATION_CONFIG);
    }
  }

  private readonly onViewportChange = (): void => {
    this.registry.markAllDirty();
    this.sceneDirty = true;
    this.scheduleRender();
  };

  private readonly onScroll = (): void => {
    this.registry.markAllDirty();
    this.scheduleRender();
  };

  private readonly onFontsLoaded = (): void => {
    this.registry.markAllDirty();
    this.sceneDirty = true;
    this.scheduleRender();
  };

  private throwIfDisposed(): void {
    if (this.disposed) {
      throw new Error("UkiboriDom has been disposed");
    }
  }
}

function defaultScheduler(cb: () => void): void {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(cb);
  } else {
    setTimeout(cb, 0);
  }
}

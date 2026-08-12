import {
  DEFAULT_ENVIRONMENT_INTENSITY,
  DEFAULT_ENVIRONMENT_SHARE,
  DEFAULT_EXPOSURE,
  DEFAULT_LIGHT_DIRECTION,
  GpuScenePipeline,
  composeSdfHeightField,
  lightScene,
  normalizeVec3,
} from "ukibori-renderer";
import type {
  GpuCanvasContextLike,
  GpuPipelineDeviceLike,
  GpuScenePipelineFrameStats,
  HostBuffer,
  LightingBuffers,
  Material,
} from "ukibori-renderer";
import { computeRegion, sanitizeDpr, scaleShadowOptions } from "./coords";
import { compositeSurfaceImage } from "./compositor";
import { geometriesEqual, measureSurfaceElement } from "./measure";
import { OverlayCanvas, isManagedMutation, restoreSurface, suppressSurface } from "./overlay";
import type { Overlay } from "./overlay";
import { SurfaceRegistry, assertValidId } from "./registry";
import { buildScene } from "./scene-builder";
import type {
  CompositeOptions,
  DomBackend,
  DomDebugState,
  DomEnvironmentState,
  DomGpuFrameState,
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
 * - document-level MutationObserver: ANY DOM mutation can move/resize a
 *   registered element through ancestors or siblings (style, class, inserted
 *   nodes, text), so all nodes are marked dirty conservatively; the render
 *   re-measures and SKIPS when geometry is unchanged
 * - scroll (capture): node dirty, re-measured on the next render; with
 *   document-relative scene coordinates ordinary page scroll leaves geometry
 *   unchanged and the render is skipped
 * - viewport resize: node dirty + scene dirty (devicePixelRatio may have
 *   changed)
 * - font load (`document.fonts` loadingdone): node dirty + scene dirty
 * - light / intensity / environment / exposure / materials updates: scene dirty
 *
 * All invalidation coalesces through a single rAF-throttled `render()`.
 *
 * ## Backends
 *
 * The SYNCHRONOUS constructor is always the CPU reference path (existing
 * tests/compatibility contract) and never touches `navigator.gpu`. The ASYNC
 * `UkiboriDom.create()` path additionally wires the #29/#31
 * `GpuScenePipeline` when `backend` is `"auto"` (WebGPU first, honest CPU
 * fallback) or `"webgpu"` (WebGPU only; throws when unavailable). On the GPU
 * path the pipeline presents DIRECTLY to the overlay's dedicated WebGPU
 * canvas — no readback, no 2D copy, no host pixel copies — while the overlay
 * RETAINS its separate Canvas2D canvas so a GPU init/render/device-loss
 * failure can switch ONCE to the CPU path without acquiring incompatible
 * contexts on the same canvas. The fallback is never retried; the reason is
 * reported in `debugState().gpuFallbackReason` (and to `onError` on render
 * failure).
 */

/**
 * The minimal GPU adapter surface the layer needs (structural: the real
 * `GPUAdapter` satisfies it; the cast happens at the `navigator.gpu`
 * boundary, mirroring the renderer's own harness casts). A test seam can
 * supply a mock instead of `navigator.gpu`.
 */
export interface DomGpuAdapterLike {
  requestDevice(): Promise<GpuPipelineDeviceLike & { destroy?: () => void }>;
}

/**
 * GPU acquisition source: the `navigator.gpu`-equivalent surface used by the
 * async backend paths. Tests inject a fake via `options.gpu`.
 */
export interface DomGpuSource {
  requestAdapter(): Promise<DomGpuAdapterLike | null>;
  getPreferredCanvasFormat(): "rgba8unorm" | "bgra8unorm";
}

export interface UkiboriDomOptions {
  /** backend policy for the ASYNC `UkiboriDom.create()` path (default
   * "auto"). The synchronous constructor is always CPU: it never touches
   * `navigator.gpu`, `"webgpu"` throws there (async creation is required),
   * and `"auto"` there means the constructor alone will not attempt the GPU
   * (call `create()` for the GPU-capable lifecycle). */
  backend?: DomBackend;
  /** test seam replacing `navigator.gpu` on the async GPU paths */
  gpu?: DomGpuSource;
  light?: Partial<DomLightState>;
  /** shared environment illumination (#22): uniform, intensity 0 = off; the
   * diffuse/specular shares independently zero out each term */
  environment?: Partial<DomEnvironmentState>;
  /** exposure multiplier applied before sRGB encoding (#22) */
  exposure?: number;
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
    /**
     * The stage element: the container of the registered surfaces. The
     * overlay canvas is inserted as its first child (so it paints inside
     * the stage's stacking context — above opaque ancestor backgrounds,
     * below the surfaces) and the stage receives the managed
     * `data-ukibori-stage` attribute (`isolation: isolate`, no layout
     * effect). Defaults to `document.body`; for the opaque-container case
     * pass the element that wraps your surfaces.
     */
    stage?: Element;
    /** overlay z-index (default -1: below the stage's in-flow content) */
    zIndex?: number;
    /** test seam: supply a fake overlay instead of a real canvas */
    factory?: () => Overlay;
  };
  /** scheduler for the render loop (default `requestAnimationFrame`) */
  schedule?: (cb: () => void) => void;
  /** error reporter (default `console.error`); render failures do not throw */
  onError?: (error: unknown) => void;
  /** wire DOM observers (default true; `false` also skips creating the
   * ResizeObserver / MutationObserver instances) */
  observe?: boolean;
}

const DEFAULT_MARGIN = 64;
const DEFAULT_INTENSITY = 1;
/**
 * Document-level observer config: ANY DOM mutation (attributes, child lists,
 * text) anywhere can move or resize a registered element through ancestors
 * and siblings, so the layer invalidates conservatively via `markAllDirty`
 * and lets the rAF-coalesced render skip when geometry is unchanged. No
 * per-frame rescanning.
 */
const MUTATION_CONFIG: MutationObserverInit = {
  attributes: true,
  childList: true,
  subtree: true,
  characterData: true,
};

export class UkiboriDom {
  readonly registry: SurfaceRegistry;
  private readonly overlay: Overlay;
  private readonly scheduler: (cb: () => void) => void;
  private readonly onError: (error: unknown) => void;
  private readonly gpuSource: DomGpuSource;
  private margin: number;
  private dprSource: number | (() => number) | undefined;
  private compositeOptions: CompositeOptions;
  private shadowOptions: DomShadowOptions;

  private light: DomLightState;
  private environment: DomEnvironmentState;
  private exposure: number;
  private materials: Record<string, Material> | undefined;

  private readonly resizeObserver: ResizeObserver | null;
  private readonly mutationObserver: MutationObserver | null;

  private renderScheduled = false;
  private disposed = false;
  private sceneDirty = true;
  private forceRender = true;

  /** the #29/#31 pipeline while the WebGPU path is active (null = CPU path) */
  private gpuPipeline: GpuScenePipeline | null = null;
  /** Device requested by this layer, therefore also owned and destroyed by it. */
  private gpuDevice: (GpuPipelineDeviceLike & { destroy?: () => void }) | null = null;
  /** one-shot GPU attempt: a fallback is never retried (honest "switch once") */
  private gpuAttempted = false;
  private gpuFallbackReason: string | null = null;
  private lastGpuFrame: DomGpuFrameState | null = null;

  private lastRegion: { x: number; y: number; w: number; h: number } | null = null;
  private lastDpr = 1;
  private lastRenderSize: { width: number; height: number } | null = null;
  private lastRenderMs = 0;
  private lastBuffers: LightingBuffers | null = null;
  private lastObjectId: HostBuffer | null = null;

  constructor(options: UkiboriDomOptions = {}) {
    if (options.backend === "webgpu") {
      throw new TypeError(
        "UkiboriDom: the synchronous constructor is CPU-only; WebGPU requires the async UkiboriDom.create() path",
      );
    }
    this.gpuSource = options.gpu ?? defaultGpuSource();
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
    this.environment = sanitizeEnvironmentState(options.environment);
    this.exposure =
      Number.isFinite(options.exposure) && (options.exposure ?? 0) >= 0
        ? (options.exposure ?? DEFAULT_EXPOSURE)
        : DEFAULT_EXPOSURE;
    this.materials = options.materials;
    this.overlay =
      options.overlay?.factory !== undefined
        ? options.overlay.factory()
        : new OverlayCanvas(options.overlay?.stage, options.overlay?.zIndex ?? -1);

    const observe = options.observe !== false;
    this.resizeObserver =
      observe && typeof ResizeObserver === "function"
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

    // One DOCUMENT-level observer: ancestor/sibling mutations can move a
    // registered element without touching it directly (the per-surface
    // observer would miss them). Conservative markAllDirty + the
    // unchanged-geometry skip keep it cheap. Ukibori's OWN DOM mutations
    // (overlay canvas, injected stylesheet, managed data-ukibori-* attributes)
    // are filtered out so the render output cannot feed back into another
    // render.
    this.mutationObserver =
      observe && typeof MutationObserver === "function"
        ? new MutationObserver((mutations) => {
            const overlayNode = this.overlay.node ?? null;
            for (const mutation of mutations) {
              if (!isManagedMutation(mutation, overlayNode)) {
                this.registry.markAllDirty();
                this.scheduleRender();
                return;
              }
            }
          })
        : null;

    if (observe) {
      if (typeof window !== "undefined") {
        window.addEventListener("resize", this.onViewportChange);
      }
      if (typeof document !== "undefined") {
        document.addEventListener("scroll", this.onScroll, true);
        const fonts = document.fonts;
        fonts?.addEventListener?.("loadingdone", this.onFontsLoaded);
        this.mutationObserver?.observe(document.documentElement, MUTATION_CONFIG);
      }
    }
  }

  /**
   * ASYNC creation/initialization path (the GPU-capable lifecycle; React
   * `Ukibori` uses this for backend auto/cpu/webgpu).
   *
   * - `"cpu"`: the CPU reference path; `navigator.gpu` is never touched.
   * - `"auto"` (default): a real `navigator.gpu` adapter/device is requested
   *   and, when available, the `GpuScenePipeline` presents DIRECTLY to the
   *   overlay's WebGPU canvas (no readback, no 2D copy). Any GPU failure
   *   (unavailable adapter/device, missing webgpu context, render error,
   *   device loss) switches ONCE to the honest CPU path; the reason stays
   *   visible in `debugState().gpuFallbackReason`.
   * - `"webgpu"`: WebGPU only — throws when the GPU path cannot initialize
   *   (an explicit request is never silently downgraded).
   */
  static async create(options: UkiboriDomOptions = {}): Promise<UkiboriDom> {
    const backend = options.backend ?? "auto";
    if (backend === "cpu") {
      return new UkiboriDom(options);
    }
    // The synchronous constructor is CPU-only by contract; enable the GPU
    // through the async path here.
    const layer = new UkiboriDom({ ...options, backend: "cpu" });
    const ok = await layer.tryEnableWebGpu();
    if (!ok && backend === "webgpu") {
      const reason = layer.gpuFallbackReason ?? "unknown GPU initialization failure";
      layer.dispose();
      throw new Error(`UkiboriDom: WebGPU requested but unavailable (${reason})`);
    }
    return layer;
  }

  /** Request the WebGPU adapter/device and wire the `GpuScenePipeline`.
   * Never throws: every failure is recorded as `gpuFallbackReason` and the
   * layer stays on the CPU path. One-shot: after an attempt (success or
   * failure) later calls return the cached outcome — a GPU fallback is never
   * retried. */
  private async tryEnableWebGpu(): Promise<boolean> {
    if (this.gpuAttempted) {
      return this.gpuPipeline !== null;
    }
    this.gpuAttempted = true;
    try {
      const adapter = await this.gpuSource.requestAdapter();
      if (adapter === null) {
        throw new Error("no WebGPU adapter available");
      }
      const device = await adapter.requestDevice();
      const canvas = this.overlay.gpuCanvas();
      const context = canvas.getContext("webgpu") as unknown as GpuCanvasContextLike | null;
      if (context === null) {
        throw new Error("WebGPU canvas context unavailable");
      }
      const canvasFormat = this.gpuSource.getPreferredCanvasFormat();
      const pipeline = new GpuScenePipeline(device, context, canvasFormat);
      this.gpuDevice = device;
      this.gpuPipeline = pipeline;
      this.gpuFallbackReason = null;
      // Device loss fails the pipeline closed; switch once to CPU and
      // re-render through the retained CPU canvas.
      void device.lost.then(
        () => {
          this.onGpuDeviceLost();
        },
        () => {
          this.onGpuDeviceLost();
        },
      );
      this.overlay.setBackend("webgpu");
      return true;
    } catch (error) {
      this.gpuFallbackReason = describeError(error);
      this.disposeGpuResources();
      this.overlay.setBackend("cpu");
      return false;
    }
  }

  /** The one-time GPU -> CPU switch (device loss or a failing render). After
   * this, every render stays on the CPU path; the GPU pipeline is disposed
   * and its resources released. `forceRender` guarantees the immediately
   * scheduled re-render ignores the retained skip (the CPU canvas must be
   * painted to replace the lost GPU frame). */
  private onGpuDeviceLost(): void {
    if (this.gpuPipeline === null || this.disposed) {
      return;
    }
    this.gpuFallbackReason = "WebGPU device lost";
    this.disposeGpuResources();
    this.overlay.setBackend("cpu");
    this.forceRender = true;
    this.scheduleRender();
  }

  private disposeGpuResources(): void {
    const pipeline = this.gpuPipeline;
    const device = this.gpuDevice;
    // Clear these first: destroying a real GPUDevice resolves `device.lost`,
    // whose callback must see that the layer has already switched away.
    this.gpuPipeline = null;
    this.gpuDevice = null;
    if (pipeline !== null) {
      try {
        pipeline.dispose();
      } catch {
        // disposal must never mask the primary outcome
      }
    }
    try {
      device?.destroy?.();
    } catch {
      // disposal must never mask the primary outcome
    }
    this.lastGpuFrame = null;
  }

  /** Honest reason WebGPU is not in use (null when the GPU path is active). */
  debugGpuFallbackReason(): string | null {
    return this.gpuFallbackReason;
  }

  /**
   * Register a DOM element as a Ukibori surface (mount). The element's own
   * background/shadow are suppressed via the managed `data-ukibori-surface`
   * attribute (stylesheet rule) and revealed again on `unregister`.
   *
   * Atomic: duplicate ids / already-registered elements are rejected BEFORE
   * any attribute is touched, so a failed registration never leaves
   * suppression behind.
   */
  register(element: HTMLElement, options: DomSurfaceOptions): void {
    this.throwIfDisposed();
    assertValidId(options.id);
    if (this.registry.has(options.id)) {
      throw new TypeError(`duplicate surface id "${options.id}"`);
    }
    const existing = this.registry.idFor(element);
    if (existing !== undefined) {
      throw new TypeError(`element already registered as "${existing}"`);
    }
    suppressSurface(element);
    try {
      const entry = {
        id: options.id,
        element,
        options: { ...options },
        geometry: null,
        dirty: true,
      };
      this.registry.add(entry);
    } catch (error) {
      restoreSurface(element);
      throw error;
    }
    this.resizeObserver?.observe(element);
    this.sceneDirty = true;
    this.scheduleRender();
  }

  /** Remove a registered surface (unmount) and reveal its own styles. */
  unregister(id: string): void {
    // React may dispose the provider before a child surface runs its passive
    // cleanup. dispose() has already restored and cleared every surface, so a
    // late unregister is an idempotent no-op rather than an application error.
    if (this.disposed) {
      return;
    }
    const entry = this.registry.remove(id);
    if (entry === undefined) {
      return;
    }
    this.resizeObserver?.unobserve(entry.element);
    restoreSurface(entry.element);
    this.sceneDirty = true;
    this.scheduleRender();
  }

  /**
   * Merge a patch into a surface's options and invalidate it. Surface ids
   * are IMMUTABLE: changing `id` through `updateSurface` throws, because a
   * rename would re-key the registry and silently change the scene's
   * insertion / paint order. Use `unregister` + `register` to replace a
   * surface.
   */
  updateSurface(id: string, patch: Partial<DomSurfaceOptions>): void {
    this.throwIfDisposed();
    const entry = this.registry.get(id);
    if (entry === undefined) {
      return;
    }
    if (patch.id !== undefined && patch.id !== entry.options.id) {
      throw new TypeError(
        `surface ids are immutable: "${entry.options.id}" cannot be renamed to "${patch.id}"`,
      );
    }
    entry.options = { ...entry.options, ...patch, id: entry.options.id };
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

  /**
   * Replace the shared environment illumination state (#22). FULL
   * replacement: fields absent from `environment` (including on later
   * calls) resolve to their defaults — nothing is merged, so removed
   * controls never stay stale. `intensity` 0 disables the environment;
   * `diffuseIntensity` / `specularIntensity` independently zero out each
   * term.
   */
  setEnvironment(environment: Partial<DomEnvironmentState>): void {
    this.throwIfDisposed();
    this.environment = sanitizeEnvironmentState(environment);
    this.sceneDirty = true;
    this.scheduleRender();
  }

  /** Replace the exposure multiplier applied before sRGB encoding. */
  setExposure(exposure: number): void {
    this.throwIfDisposed();
    this.exposure = Number.isFinite(exposure) && exposure >= 0 ? exposure : DEFAULT_EXPOSURE;
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

  /** Replace the cast-shadow pass options (#17). FULL replacement: fields
   * absent from `options` (including on later calls) resolve to their
   * defaults; nothing is merged, so removed options never stay stale. */
  setShadow(options: DomShadowOptions): void {
    this.throwIfDisposed();
    this.shadowOptions = { ...options };
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

  /** Replace the scene-region shadow margin (CSS px). `undefined` resets to
   * the default (64). */
  setMargin(margin: number | undefined): void {
    this.throwIfDisposed();
    this.margin =
      typeof margin === "number" && Number.isFinite(margin) && margin >= 0
        ? margin
        : DEFAULT_MARGIN;
    this.sceneDirty = true;
    this.scheduleRender();
  }

  /** Replace the compositor mapping options (absent fields resolve to their
   * defaults — full replacement, nothing merged). */
  setCompositing(options: CompositeOptions): void {
    this.throwIfDisposed();
    this.compositeOptions = options;
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
   * changed, otherwise rebuild the scene (geometry + light + DPR) and render
   * through the ACTIVE backend — the `GpuScenePipeline` presenting directly
   * to the WebGPU canvas when available, otherwise the CPU reference pipeline
   * composited onto the Canvas2D canvas. A GPU render failure switches ONCE
   * to the CPU path (recorded in `gpuFallbackReason`) and re-renders the same
   * frame through it.
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
      // Nothing to render: show the cleared (transparent) CPU canvas and hide
      // any WebGPU canvas — the GPU pipeline itself stays alive for reuse.
      this.overlay.setBackend("cpu");
      this.overlay.clear();
      this.lastRegion = null;
      this.lastRenderSize = null;
      this.lastBuffers = null;
      this.lastObjectId = null;
      this.lastGpuFrame = null;
      this.sceneDirty = false;
      this.lastRenderMs = performance.now() - startedAt;
      return;
    }

    const dpr = this.currentDpr();
    let scene: ReturnType<typeof buildScene>;
    try {
      scene = buildScene({
        registry: this.registry,
        region,
        dpr,
        light: this.light,
        environment: this.environment,
        exposure: this.exposure,
        materials: this.materials,
      });
    } catch (error) {
      this.onError(error);
      this.lastRenderMs = performance.now() - startedAt;
      return;
    }

    const painted =
      this.gpuPipeline !== null
        ? this.renderGpuScene(scene, region, dpr, startedAt)
        : this.renderCpuScene(scene, region, dpr, startedAt);
    if (!painted) {
      // the failure was already reported (or the GPU->CPU switch already
      // re-rendered the frame); nothing was painted, so keep the previous
      // committed state
      return;
    }

    this.lastRegion = region;
    this.lastDpr = dpr;
    this.sceneDirty = false;
    this.lastRenderMs = performance.now() - startedAt;
  }

  /**
   * GPU frame path: drive the retained `GpuScenePipeline` end to end. The
   * pipeline uploads the encoded scene, runs the compute chain and presents
   * DIRECTLY to the overlay's WebGPU canvas — no readback and no 2D copy. A
   * thrown stage (validation/device failure) switches ONCE to the CPU path
   * and re-renders the same frame through it.
   */
  private renderGpuScene(
    scene: ReturnType<typeof buildScene>,
    region: { x: number; y: number; w: number; h: number },
    dpr: number,
    startedAt: number,
  ): boolean {
    try {
      const pipeline = this.gpuPipeline!;
      const stats: GpuScenePipelineFrameStats = pipeline.render({
        scene,
        dpr,
        shadowOptions: scaleShadowOptions(this.shadowOptions, dpr),
        lightingOptions: undefined,
        compositeOptions: this.compositeOptions,
      });
      this.overlay.setBackend("webgpu");
      this.overlay.resizeAndPosition(region, dpr);
      this.lastGpuFrame = { frame: stats, hostRenderMs: performance.now() - startedAt };
      this.lastBuffers = null;
      this.lastObjectId = null;
      this.lastRenderSize = { width: stats.renderWidth, height: stats.renderHeight };
      return true;
    } catch (error) {
      // GPU path failed: switch once to CPU (never retried) and re-render
      // the same frame through the retained Canvas2D canvas.
      this.gpuFallbackReason = describeError(error);
      this.onError(error);
      this.disposeGpuResources();
      this.overlay.setBackend("cpu");
      return this.renderCpuScene(scene, region, dpr, startedAt);
    }
  }

  /**
   * CPU frame path (the reference implementation): compose the height field
   * once for the ownership buffer, shade, composite and paint onto the
   * Canvas2D canvas. The intermediate host buffers stay available for debug
   * views (`debugBuffers` / `debugObjectId`).
   */
  private renderCpuScene(
    scene: ReturnType<typeof buildScene>,
    region: { x: number; y: number; w: number; h: number },
    dpr: number,
    startedAt: number,
  ): boolean {
    let buffers: LightingBuffers;
    try {
      // Compose the height field once for the ownership buffer (#18 objectId);
      // `lightScene` re-runs the same composition internally for its shading
      // passes, so the two are guaranteed consistent. This CPU double-compose
      // is the reference implementation cost; the GPU backend merges them.
      const composed = composeSdfHeightField(scene);
      // The scene is the dpr-scaled similarity image of the CSS-space scene;
      // shadow lengths must be mapped through the same transform (the
      // renderer defaults for step/bias are materialized at 0.5 CSS px).
      buffers = lightScene(scene, {
        shadow: scaleShadowOptions(this.shadowOptions, dpr),
      });
      this.lastObjectId = composed.objectId;
    } catch (error) {
      this.onError(error);
      this.lastRenderMs = performance.now() - startedAt;
      return false;
    }

    const image = compositeSurfaceImage(
      {
        color: buffers.color,
        objectId: this.lastObjectId!,
        visibility: buffers.visibility ?? null,
      },
      this.compositeOptions,
    );

    this.overlay.setBackend("cpu");
    this.overlay.resizeAndPosition(region, dpr);
    this.overlay.paint(image);

    this.lastRenderSize = { width: image.width, height: image.height };
    this.lastBuffers = buffers;
    this.lastGpuFrame = null;
    return true;
  }

  /** Intermediate renderer buffers from the last CPU render (debug views).
   * Always null on the WebGPU path: the GPU frame never makes host pixel
   * copies, so there is nothing honest to expose. */
  debugBuffers(): LightingBuffers | null {
    return this.lastBuffers;
  }

  /** Owning-surface buffer (#18 objectId) from the last CPU render (debug
   * views). Always null on the WebGPU path (no host copies). */
  debugObjectId(): HostBuffer | null {
    return this.lastObjectId;
  }

  /** Current shadow pass options (debug views / tests). */
  debugShadowOptions(): Readonly<DomShadowOptions> {
    return this.shadowOptions;
  }

  /** Current environment illumination state (debug views / tests). */
  debugEnvironment(): Readonly<DomEnvironmentState> {
    return { ...this.environment };
  }

  /** Current exposure multiplier (debug views / tests). */
  debugExposure(): number {
    return this.exposure;
  }

  debugState(): DomDebugState {
    return {
      nodeCount: this.registry.size,
      dirtyCount: this.registry.dirtyCount(),
      region: this.lastRegion === null ? null : { ...this.lastRegion },
      dpr: this.lastDpr,
      lastRenderMs: this.lastRenderMs,
      renderSize: this.lastRenderSize === null ? null : { ...this.lastRenderSize },
      backend: this.gpuPipeline !== null ? "webgpu" : "cpu",
      gpuFallbackReason: this.gpuFallbackReason,
      gpuFrame: this.lastGpuFrame,
    };
  }

  /** Remove the overlay, disconnect observers, dispose the GPU pipeline and
   * reveal all surface styles. */
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
    this.disposeGpuResources();
    for (const entry of this.registry.entries()) {
      restoreSurface(entry.element);
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

/**
 * Sanitize a partial environment state into a full one (renderer #22
 * policy): intensity finite >= 0 (invalid -> 0.5), shares finite clamped
 * to [0, 1] (invalid -> 1). 0 is preserved for all three controls.
 */
function sanitizeEnvironmentState(
  environment: Partial<DomEnvironmentState> | undefined,
): DomEnvironmentState {
  const intensity = environment?.intensity;
  return {
    intensity:
      typeof intensity === "number" && Number.isFinite(intensity) && intensity >= 0
        ? intensity
        : DEFAULT_ENVIRONMENT_INTENSITY,
    diffuseIntensity: sanitizeShare(environment?.diffuseIntensity),
    specularIntensity: sanitizeShare(environment?.specularIntensity),
  };
}

function sanitizeShare(v: number | undefined): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return DEFAULT_ENVIRONMENT_SHARE;
  }
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * The real `navigator.gpu` acquisition surface. The GPU objects are cast at
 * this boundary (the renderer's own harness-cast convention): the real
 * `GPUAdapter`/`GPUDevice` structurally satisfy the narrow `DomGpuSource` /
 * `GpuPipelineDeviceLike` surfaces. When `navigator.gpu` is missing the
 * source simply reports no adapter, which makes the "auto" path fall back to
 * CPU with an honest reason.
 */
function defaultGpuSource(): DomGpuSource {
  const gpu = typeof navigator === "undefined" ? undefined : (navigator as { gpu?: DomGpuSource }).gpu;
  if (gpu === undefined) {
    return {
      async requestAdapter(): Promise<DomGpuAdapterLike | null> {
        return null;
      },
      getPreferredCanvasFormat(): "rgba8unorm" | "bgra8unorm" {
        return "rgba8unorm";
      },
    };
  }
  return gpu;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

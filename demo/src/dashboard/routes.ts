/**
 * Demo dashboard hash routes.
 *
 * The dashboard is a single page: the URL fragment selects exactly one view.
 * Parsing is pure so direct loads, `hashchange` (back/forward, manual edits)
 * and unknown fragments are all resolved deterministically. Anything that is
 * not a recognized route — including an empty hash — falls back to the
 * Playground.
 */

export const DASHBOARD_VIEWS = ["playground", "features", "diagnostics", "product"] as const;

export type DashboardView = (typeof DASHBOARD_VIEWS)[number];

export const DIAGNOSTICS_IDS = [
  "renderer",
  "scheduler",
  "wasm",
  "dom",
  "profiles",
  "emissive",
] as const;

export type DiagnosticsId = (typeof DIAGNOSTICS_IDS)[number];

export interface DiagnosticsPage {
  id: DiagnosticsId;
  /** Selector label shown in the diagnostics subnavigation. */
  label: string;
  /** Retained standalone page (same-origin). */
  page: string;
  /** iframe `title` (a short accessible description of the embedded page). */
  frameTitle: string;
  /** On-page heading for the embedded page. */
  title: string;
  /** On-page description of what the legacy page demonstrates. */
  description: string;
}

export const DIAGNOSTICS_PAGES: readonly DiagnosticsPage[] = [
  {
    id: "renderer",
    label: "Renderer",
    page: "/renderer-debug.html",
    frameTitle: "Renderer intermediate buffer debug page",
    title: "Renderer debug (#14–#19)",
    description:
      "Intermediate buffers of the physical pipeline: SDF → height field → normals → material lighting → cast shadows.",
  },
  {
    id: "scheduler",
    label: "Scheduler",
    page: "/scheduler-debug.html",
    frameTitle: "Dirty scheduler and tile planner debug page",
    title: "Scheduler debug (#31/#32)",
    description:
      "Retained-pass scheduling and the tile planner: invalidation reasons, executed stages, dirty regions and partial recompute.",
  },
  {
    id: "wasm",
    label: "WASM",
    page: "/wasm-debug.html",
    frameTitle: "WASM CPU fallback diagnostics page",
    title: "WASM fallback diagnostics (#33)",
    description:
      "WASM-assisted CPU fallback: stage provenance, transfer volume, memory, exact parity and TS/WASM/WebGPU benchmarks.",
  },
  {
    id: "dom",
    label: "DOM integration",
    page: "/dom-debug.html",
    frameTitle: "DOM integration debug page",
    title: "DOM integration debug (#20)",
    description:
      "Real DOM elements (button, text) enhanced by the physical layer while layout, focus and events stay DOM-owned.",
  },
  {
    id: "profiles",
    label: "Height profiles",
    page: "/profile-debug.html",
    frameTitle: "Height profile comparison page",
    title: "Height profile comparison (#61)",
    description:
      "Deterministic comparison of step, linear, smooth, convex, concave and power height profiles, raised and inset.",
  },
  {
    id: "emissive",
    label: "Emissive / bloom",
    page: "/emissive-debug.html",
    frameTitle: "Emissive materials and bloom debug page",
    title: "Emissive materials, illumination and bloom",
    description:
      "Linear HDR emissive materials plus independent nearby-illumination and separable Gaussian bloom controls.",
  },
];

export function isDiagnosticsId(value: string): value is DiagnosticsId {
  return (DIAGNOSTICS_IDS as readonly string[]).includes(value);
}

export type DashboardRoute =
  | { view: "playground"; hash: "#playground" }
  | { view: "features"; hash: "#features" }
  | { view: "diagnostics"; id: DiagnosticsId; hash: string }
  | { view: "product"; hash: "#product" };

export const PLAYGROUND_ROUTE: DashboardRoute = { view: "playground", hash: "#playground" };

/**
 * Resolve a `location.hash` value to a route.
 *
 * Parsing is strict: only the exact fragments `#playground`, `#features`,
 * `#product` and `#diagnostics/<known-id>` are valid. A missing or extra
 * segment or an unknown value (including an empty hash) safely resolves to
 * the Playground.
 */
export function parseDashboardHash(hash: string): DashboardRoute {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  switch (raw) {
    case "playground":
      return PLAYGROUND_ROUTE;
    case "features":
      return { view: "features", hash: "#features" };
    case "product":
      return { view: "product", hash: "#product" };
    default:
      break;
  }
  const segments = raw.split("/");
  if (
    segments.length === 2 &&
    segments[0] === "diagnostics" &&
    isDiagnosticsId(segments[1])
  ) {
    return { view: "diagnostics", id: segments[1], hash: `#diagnostics/${segments[1]}` };
  }
  return PLAYGROUND_ROUTE;
}

export function diagnosticsPage(id: DiagnosticsId): DiagnosticsPage {
  return DIAGNOSTICS_PAGES.find((page) => page.id === id)!;
}

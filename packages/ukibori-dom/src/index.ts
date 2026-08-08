export { UkiboriDom } from "./dom-layer";
export type { UkiboriDomOptions } from "./dom-layer";
export { SurfaceRegistry } from "./registry";
export type { SurfaceEntry } from "./registry";
export { assertValidId } from "./registry";
export {
  OverlayCanvas,
  SURFACE_ATTR,
  STAGE_ATTR,
  STYLE_ATTR,
  ensureOverlayStylesheet,
  restoreSurface,
  suppressSurface,
} from "./overlay";
export type { Overlay } from "./overlay";
export { compositeSurfaceImage, DEFAULT_SHADOW_ALPHA, DEFAULT_SHADOW_COLOR } from "./compositor";
export type { CompositeInput } from "./compositor";
export { buildScene } from "./scene-builder";
export type { BuildSceneInput } from "./scene-builder";
export { computeRegion, renderTargetSize, sanitizeDpr, viewportRectToDocument } from "./coords";
export type { ViewportRect } from "./coords";
export {
  geometriesEqual,
  measureSurfaceElement,
  readComputedBorderRadius,
  readPageScroll,
  readViewportRect,
} from "./measure";
export type {
  CompositeOptions,
  DomDebugState,
  DomLightState,
  DomShadowOptions,
  DomShape,
  DomSurfaceOptions,
  MeasuredGeometry,
  Region,
  SurfaceImage,
} from "./types";

import type { Material } from "./material";
import type { LinearRgb } from "./types";

/** An explicit, opaque, uniform receiver. Colors are LINEAR reflectance, not CSS. */
export interface BasePlaneOptions {
  readonly baseColor: LinearRgb;
}

/** Canonical values also used by retained-frame keys and GPU uniforms. */
export function sanitizeBasePlane(plane: BasePlaneOptions | undefined): BasePlaneOptions | undefined {
  if (plane === undefined) return undefined;
  const channel = (v: number) => Math.fround(Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);
  return { baseColor: { r: channel(plane.baseColor.r), g: channel(plane.baseColor.g), b: channel(plane.baseColor.b) } };
}

/** Fixed matte dielectric response; floor emission/material editing is out of scope. */
export function basePlaneMaterial(plane: BasePlaneOptions): Material {
  return { baseColor: plane.baseColor, roughness: 0.9, metallic: 0, ior: 1.5 };
}

import type { ComponentPropsWithRef, ElementType, ReactNode } from "react";
import type { MaterialTokensOverride } from "./core/materials";

export interface LightVector {
  x: number;
  y: number;
  z: number;
}

export type MaterialName = "silicone" | "matte" | "glass" | "metal";

export type Variant = "raised" | "inset";

export interface UkiboriProps {
  light?: LightVector;
  intensity?: number;
  color?: string;
  children?: ReactNode;
}

export interface SurfaceOwnProps {
  material?: MaterialName;
  variant?: Variant;
  elevation?: number;
  radius?: number;
  /** Type-safe partial override of the material token set. */
  materialOverrides?: MaterialTokensOverride;
}

/**
 * Polymorphic props for Surface: DOM props are resolved per element type C,
 * so `as="button"` accepts button-specific props (type, onClick, ...) and
 * rejects props of other elements at compile time.
 */
export type PolymorphicSurfaceProps<C extends ElementType = "div"> = Omit<
  ComponentPropsWithRef<C>,
  keyof SurfaceOwnProps | "as"
> &
  SurfaceOwnProps & { as?: C };

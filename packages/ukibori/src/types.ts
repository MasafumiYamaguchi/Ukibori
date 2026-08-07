import type { CSSProperties, ElementType, HTMLAttributes, ReactNode } from "react";

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
}

export interface SurfaceProps extends HTMLAttributes<HTMLElement>, SurfaceOwnProps {
  as?: ElementType;
  className?: string;
  style?: CSSProperties;
}

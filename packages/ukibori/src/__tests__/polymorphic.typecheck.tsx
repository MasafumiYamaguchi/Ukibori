import type { ReactNode } from "react";
import { Surface, Ukibori } from "../index";
import type { PolymorphicSurfaceProps } from "../index";

export const valid: ReactNode = (
  <Ukibori light={{ x: -0.6, y: -0.8, z: 1 }} intensity={1}>
    <Surface as="button" type="submit" onClick={() => {}} aria-label="go" data-testid="btn">
      x
    </Surface>
    <Surface as="a" href="/path" target="_blank">
      link
    </Surface>
    <Surface as="input" type="checkbox" aria-checked="true" />
    <Surface as="span" material="glass" variant="inset" elevation={6} radius={20} />
  </Ukibori>
);

// @ts-expect-error href is not valid on a button surface
export const invalidHref: ReactNode = <Surface as="button" href="/x">x</Surface>;

// @ts-expect-error elevation must be a number
export const invalidElevation: ReactNode = <Surface elevation="6">x</Surface>;

// material is a renderer ref (string) — any string is type-valid; unknown
// refs fail at scene build time and are reported, leaving semantic DOM.
export const stringMaterial: ReactNode = <Surface material="silicone">x</Surface>;

// @ts-expect-error unknown variant value
export const invalidVariant: ReactNode = <Surface variant="embossed">x</Surface>;

// @ts-expect-error material override values must match token types
export const invalidOverride: ReactNode = <Surface materialOverrides={{ shadowAlpha: "0.5" }}>x</Surface>;

export const validOverride: ReactNode = (
  <Surface materialOverrides={{ shadowAlpha: 0.5, borderWidth: 2, backdropFilter: null }}>x</Surface>
);

export const buttonProps: PolymorphicSurfaceProps<"button"> = { as: "button", type: "submit" };

export default valid;

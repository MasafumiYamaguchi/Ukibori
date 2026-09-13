# Issue #74 implementation report — emissive illumination must lift directionally-shadowed regions

Issue: [#74](https://github.com/MasafumiYamaguchi/Ukibori/issues/74)
Branch: `codex/glyph-supersampling-shadow` (continued)

## Reproduction

Scene (scene units, +x right / +y down / +z toward the viewer):

- a `receiver` plane (owned surface and/or the page base plane);
- an emissive `emitter` next to it (cyan HDR `{0.1·k, 0.6·k, k}`);
- a raised `blocker` UP-LIGHT of the emitter, so the directional cast shadow
  crosses the emitter's surroundings;
- the emitter -> receiver line of sight does NOT pass through the blocker, so
  a valid emissive contribution exists inside the directional shadow;
- directional light `{0.9, -0.35, 0.25}` (grazing) so the shadow is long.

Comparison cases: short shadow, long shadow, long + bloom off, long +
emissive intensity 0, long + emissive enabled.

Visual fixture (real DOM, production CPU path): the cast shadow is a dark
wedge over the base plane that crosses the cyan emissive glow. The glow is
present inside the wedge; the wedge is the cast-shadow tint over the page
background.

## Root cause (investigated, not assumed)

The lighting composition was **already correct** — no code path multiplies the
emissive contribution by the primary-light shadow visibility:

- CPU (`packages/renderer/src/lighting.ts`): `directLightContribution` is
  `brdfSum · NdotL · visibility · intensity · lightColor`; `ambient` and
  `environment` are separate; `material.emissive` (self-emission) is added
  AFTER the accumulation and is never scaled by visibility. Final order:
  `(base·ambient + direct·vis + env + emission) · exposure`.
- WebGPU (`gpu/lighting-pass-wgsl.ts`) mirrors that order exactly.
- Emissive-derived incident light (`emissive-effects.ts` /
  `gpu/emissive-effects-wgsl.ts` / bloom passes) accumulates the incident
  field from visible emitters and adds it independently of `visibility`. The
  shadow visibility is used ONLY to build the base-plane tint (`a0`) and the
  physical direct term; the incident `glow` is added on top
  (`rgb = shadow·a0 + encode(glow)` for the base plane,
  `rgb = encode(decode(color) + glow)` for owned pixels).

Evidence (new `packages/renderer/src/emissive-shadow.test.ts`):

- `computeEmissiveIncidentField` is **byte-identical** for short vs long
  shadows (the shadow field changes, the emissive contribution does not).
- Shadowed owned receivers brighten with emissive on (`> 90 %` of
  geometrically-shadowed receiver pixels with a clear emitter line of sight).
- The `visibility` field is unchanged by the emissive value.
- Emissive intensity 0 reproduces the physical non-emissive color exactly.
- Bloom off and on both lift the shadow.
- A self-emissive surface stays luminous.

Real WebGPU parity (extended `test-browser/emissive-effects-parity.mjs`, run
in headless Chrome on a real adapter): **80 fixtures, 908,288 compared bytes,
max byte error 0** across the new directional-shadow cases (dpr 1 / 1.5,
exposure 0 / 1, illumination and illumination+bloom).

The visible "emissive light is cut along the shadow" is therefore **not
suppression of the emissive contribution**. It is the base-plane compositing
approximation: the renderer does not paint the base plane physically; the page
background represents the reflected lighting and a fixed `shadowColor`
tint represents the directional occlusion (documented in `compositor.ts` and
`gpu/composite.ts`). The tint darkens the page background under the glow while
the glow is added at full strength, so the cast shadow remains visible inside
the emissive-lit region. This is the "shadow as a final overlay" appearance the
issue describes, but the emissive energy itself is unaffected and intensity /
falloff control it exactly (no separate "shadow lightening" parameter).

## Final composition order

```
directVisible       = direct · visibility          (primary directional light only)
reflectedLighting   = ambient/environment + directVisible + emissiveIncidentLight
finalHDR            = reflectedLighting + surfaceEmission
finalHDR -> exposure -> sRGB encode -> bloom (presentation) -> DOM compositing
```

`shadowVisibility` scales only the direct term. `emissiveIncidentLight` is
accumulated by the screen-space illumination pass (visible emitters, receiver
normal/distance attenuation and the existing height checks) and added
independently. `surfaceEmission` is independent of both.

## Changes

- `packages/renderer/src/emissive-effects.ts`: extracted
  `computeEmissiveIncidentField(scene, fields, e, dpr)` — the per-pixel linear
  emissive incident contribution the illumination pass adds, BEFORE the
  receiver baseColor/exposure/intensity modulation. `renderIllumination`
  consumes exactly this field, so a debug view can never diverge from the
  rendered result. Behavior is byte-identical (f64 accumulation preserved).
- `packages/renderer/src/index.ts`: export the new debug field.
- `packages/renderer/src/emissive-shadow.test.ts`: deterministic #74 fixture
  and regression gate (short/long, bloom on/off, emissive 0/on, self-emission,
  hard/soft/reconstructed, debug contributions).
- `packages/renderer/test-browser/emissive-effects-parity.mjs`: directional
  shadow + blocker CPU/GPU parity cases.

No renderer lighting equation, shadow algorithm, bloom, tone mapping or
compositing semantics were changed.

## Debug fixture

`computeEmissiveIncidentField` exposes the emissive incident light. Together
with the existing buffers the fixture can show: direct contribution
(`lightScene`/`shading` color), shadow visibility (`buffers.visibility`),
emissive incident (`computeEmissiveIncidentField`), final pre-bloom lighting
(`renderEmissiveEffects` with bloom off) and the presented color, plus local
surface emission (the physical color with no incident).

## Results by required case

- short vs long shadow: the visibility field grows, the emissive incident field
  is identical.
- emissive intensity 0: exact physical non-emissive result.
- emissive enabled: shadowed owned receivers and base-plane receivers brighten
  by the incident contribution; grazing/intensity behavior is the existing
  `emissive.illumination` model (no new parameter).
- bloom off: emissive illumination remains.
- hard / soft / reconstructed: identical emissive incident; each mode has
  shadowed receivers that brighten (the shadow algorithm only changes
  `visibility`).
- self-emissive surface: stays luminous in shadow.
- CPU/WebGPU: byte-identical (tolerance 1; observed 0).
- retained/partial updates: unchanged; the existing scheduling tests
  (`pipeline.test.ts` emissive value/edit cases) pass.

## Remaining limitation

- Emissive-source occlusion (blocker between the emitter and the receiver) is
  the existing screen-space height approximation and is out of scope here; the
  fixture deliberately keeps the emitter line of sight clear.
- The base plane is not physically shaded (the page background is the base
  plane). The cast shadow on the base plane is the documented `shadowColor`
  compositing tint. Inside an emissive-lit region the tint remains visible as
  a darker band over the page background; making the base plane physically
  shaded is a presentation-model change beyond this issue (and would alter
  current ambient/compositing semantics), so it was not applied.

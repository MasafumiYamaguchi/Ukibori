# ukibori-renderer

Backend-agnostic 2.5D renderer core for Ukibori. React- and DOM-free: scenes
are plain data, buffers are typed arrays, and the WebGPU pipeline is reached
through the `RenderBackend` interface.

Ukibori is a physically-informed 2.5D renderer for DOM UI, not a CSS shadow
generator. The renderer pipeline is:

```
shape (SDF or mask) -> height field -> normal field -> material + shared light
-> BRDF surface lighting + height-field shadow visibility -> RGBA
```

CSS approximations (`box-shadow`, gradients) are NOT part of the renderer
core. They are only a possible future fallback layer.

## Coordinate conventions

| Axis | Meaning |
| --- | --- |
| x | right, scene units = CSS pixels |
| y | down |
| z | toward the viewer; geometry is a height field `z = H(x, y)` |

- `elevation` is absolute scene-space z (not z-index, not parent-relative)
- `devicePixelRatio` is a render-target concern and is never mixed into scene
  units
- scene `width` / `height` are positive integers (CSS-pixel render region)
- **pixel sampling**: render-target pixel `(x, y)` samples the height field at
  the continuous position `(x + 0.5, y + 0.5)` (pixel centers)

## Light direction

`DirectionalLight.direction` points FROM the receiver surface TOWARD the light
source. A light at upper-left-front is `{ x: -0.6, y: -0.8, z: 1 }`.
Cast-shadow rays travel along this direction. `createScene` normalizes the
direction; invalid input falls back to `+z` (straight at the viewer).

## Scene model

- `SurfaceNode`: position (top-left), size, absolute `elevation` (z of the
  surface base), optional `thickness` (local profile height range, top z is
  `elevation + localHeight`), optional `bevelWidth` (half-width of the smooth
  edge rise), `shape` (roundedRect / mask), `profile`, `material` id,
  `castsShadow` / `receivesShadow`
- `Scene`: render region + surfaces + shared `DirectionalLight`
- `createScene` validates structural invariants (throws on non-finite or
  negative values, empty or duplicate ids, bad flags) and sanitizes light
  direction / intensity (fallback values). See JSDoc for the full policy.

## Profile descriptors

`SurfaceNode.profile` is a **serializable descriptor** — plain data, not a
function — so the scene stays backend-agnostic and CPU/WebGPU paths interpret
the same representation.

- `{ kind: "flat" }`: constant local height `thickness` wherever the geometry
  exists (coverage is decided by the shape)
- analytic bevel kinds (smooth edge rise) are implemented by the geometry
  issue (#14)

`evaluateProfile(profile, distance, bevelWidth, thickness)` returns the local
height above the base in `[0, thickness]`; absolute scene z is
`elevation + localHeight`. `distance` is the signed distance from the shape
boundary (negative inside, zero on boundary, positive outside).

## Buffer contract

| Buffer | Format | Meaning |
| --- | --- | --- |
| height | f32 scalar | absolute scene-space z `H(x, y)` |
| normal | f32 x3 | normalized surface normal (xyz -> +z is flat) |
| objectId | u32 scalar | topmost owning surface index, `NO_OWNER` if none |
| materialId | u32 scalar | index into the scene material list |
| visibility | f32 scalar | cast-shadow visibility 0..1 |
| color | RGBA8 | final lit color target |

All pixel buffers are tightly packed row-major: `data[(y * width + x) *
channels + c]`. The WebGPU backend pads rows only inside its transfer layer.

## Composition rule

```
Hscene(x, y) = max(0, max_i surfaceHeightAt_i(x, y))
```

- `surfaceHeightAt` is evaluated at pixel centers `(x + 0.5, y + 0.5)`
- heights are rounded to f32 (`Math.fround`) before the max/equality
  comparison, so the CPU reference makes the same decisions as the f32
  WebGPU pipeline
- objectId is the INDEX into `scene.surfaces` of the surface providing the
  maximum height (not the surface `id` string); `NO_OWNER` when nothing
  covers the pixel
- exact f32-equality ties: the later surface (higher index) wins by default
  (DOM-like paint order); `tieBreak: "first"` inverts this
- geometry contract: a surface returns `-Infinity` where it has no geometry,
  finite `>= 0` absolute z where it does; any non-finite value is treated as
  no geometry
- `composeHeightField` is the CPU reference that GPU passes must reproduce

## Fixtures and verification

- `flatRoundedRectHeight`: flat-top rounded-rect geometry for ownership tests
  (not the smooth #14 profile)
- debug export: `toRgbaBytes` (height/normal/color visualization),
  `toPpmBytes` (zero-dependency file output), `sampleLine` (cross-sections)

## Verification commands

```sh
npm run typecheck -w ukibori-renderer
npm run test -w ukibori-renderer
npm run build -w ukibori-renderer
```

Browser debug page (demo): `npm run dev`, then `/renderer-debug.html`.

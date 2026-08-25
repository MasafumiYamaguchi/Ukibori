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
  `elevation + localHeight`), optional `bevelWidth` (width of the inward
  bevel band), `shape` (roundedRect / mask), `profile`, `material` id,
  `castsShadow` / `receivesShadow`
- `Scene`: render region + surfaces + shared `DirectionalLight`
- `createScene` validates structural invariants (throws on non-finite or
  negative values, empty or duplicate ids, bad flags, unknown shape/profile
  kinds) and sanitizes light direction / intensity (fallback values). See
  JSDoc for the full policy.

## Profile descriptors

`SurfaceNode.profile` is a **serializable descriptor** — plain data, not a
function — so the scene stays backend-agnostic and CPU/WebGPU paths interpret
the same representation.

- `{ kind: "flat" }`: step at the shape boundary — full thickness inside, 0 at
  the boundary and outside
- `{ kind: "bevel" }`: silicone-like smooth edge rise over the **inward** band
  `[-bevelWidth, 0]` (C1 smoothstep): full thickness at `-bevelWidth`, half at
  the mid-band, zero at the nominal boundary. The bevel never extends outside
  the shape, so `SurfaceNode.size` describes the **physical footprint**
  (DOM rounded-rect semantics).

`evaluateProfile(profile, distance, bevelWidth, thickness)` returns the local
height above the base in `[0, thickness]`; absolute scene z is
`elevation + localHeight`. `distance` is the signed distance from the shape
boundary (negative inside, zero on boundary, positive outside). This is the
CPU reference that the WebGPU/WGSL pipeline mirrors — the math is not buried
in shaders.

## SDF → height pipeline (#14)

```
shape -> roundedRectSdf (signed distance)
       -> evaluateProfile (local height)
       -> elevation + localHeight = absolute scene z H(x, y)
```

- `roundedRectSdf`: analytic rounded-box SDF (iq sdRoundBox, with the
  `min(max(q), 0)` interior term), sampled at pixel centers. Sign: negative
  inside, zero on the boundary, positive outside. `radius` is clamped to
  `min(radius, width/2, height/2)` like CSS rounded rects (radius == half
  extent is an exact circle).
- `roundedRectSurfaceHeight`: per-surface geometry for `composeHeightField`.
  **Coverage is the shape interior (`distance < 0`), independent of local
  height** — a surface with `thickness = 0` still exists at `H = elevation`
  inside its footprint. Outside the footprint it is `-Infinity`.
- `composeSdfHeightField`: full-scene height composition through the SDF
  geometry
- `generateSdfDebug`: sdf / mask / height buffers for human inspection

Note: a standalone surface at `elevation > 0` shows a vertical side wall at
its footprint (H drops from `elevation` to the base plane 0). The smooth
profile is best inspected with `elevation = 0`; raised surfaces get an
underlying base surface at `z = elevation` in the multi-surface scene (#18).

Debug views: the demo page (`/renderer-debug.html`) shows SDF, mask, height
map and a height cross-section graph; buffers can also be dumped as PPM from
tests.

## Normals and lighting (#15)

- `computeNormals`: central difference over 2px with edge samples clamped
  (replicate). `N = normalize(-dx * scaleX, -dy * scaleY, normalScale)`;
  default `scaleX = scaleY = 0.5` converts the 2px difference into the
  scene-unit slope, so `normalScale = 1` gives the geometrically exact
  normal. `normalScale` is sanitized to a finite strictly positive value
  (zero/negative/non-finite break the unit-normal invariant); normalization
  is overflow-safe for extreme scale values. Flat plateaus give `(0, 0, 1)`
  (+z = viewer).
- `shadeHeightField` / `lightScene`: shared directional light (direction
  points toward the light, #13). `scene.light.intensity` scales the direct
  terms; intensity 0 leaves ambient only. The degenerate half-vector
  `L = -V` (direction `{0, 0, -1}`) resolves specular to 0 without NaN.
  Lighting is computed in linear space and sRGB-encoded on output.
- debug buffers: `normal` (f32 x3), `diffuse` (raw N·L) / `specular`
  (specular direct contribution: `luminance(Fr) * NdotL * visibility`,
  before light intensity, f32 1ch), `color` (RGBA8), `visibility` (0/1 hard
  shadow mask, f32 1ch, present when a shadow pass ran)

## Material / BRDF (#16)

```
height -> normals -> per-pixel material (objectId -> surface -> MaterialRef)
        -> Cook-Torrance BRDF -> sRGB RGBA8
```

Material model (`Material`): `baseColor` (linear reflectance/albedo,
clamped to [0, 1] — it becomes metallic F0), `roughness` (0..1), `metallic`
(0..1), `ior` (dielectric F0 source, default 1.5). Lighting runs in linear
space with explicit sRGB encoding. CSS approximation tokens (shadowAlpha,
gradients, ...) are NOT part of this model.

- Cook-Torrance: NDF GGX and height-correlated Smith visibility share one
  regularized alpha (`ggxAlpha(roughness) = max(roughness^2,
  GGX_ALPHA_EPS)`), so they describe the same microfacet distribution —
  roughness 0 keeps a sharp mirror-like lobe instead of collapsing. Schlick
  Fresnel evaluates at **V·H** (== L·H). `F0 = mix(dielectric IOR F0,
  baseColor, metallic)`.
- BRDF evaluation is separated from the cosine factor: `brdfDirect` returns
  the Lambert diffuse BRDF `baseColor * (1 - F) * (1 - metallic) / PI`
  (metals have no diffuse) and the Cook-Torrance specular BRDF `D * V * F`;
  the lighting pass applies `NdotL * lightIntensity` to both. All terms are
  finite; the degenerate half-vector `L = -V` resolves specular to 0.
- presets: `silicone` (dielectric, medium roughness, IOR 1.45), `matte`
  (dielectric, high roughness), `metal` (metallic 1, roughness controls
  highlight width)
- scenes resolve `MaterialRef` through `Scene.materials` overrides first,
  then presets; unknown refs throw at `createScene`. Table values are
  sanitized (roughness/metallic clamped, ior >= 1).
- debug buffers: `diffuse` (raw N·L, material-independent), `specular`
  (specular direct contribution `luminance(Fr) * NdotL * visibility`, before
  light intensity), `color` (full BRDF output)

## Mask / glyph geometry (#19)

```
alpha mask -> binary silhouette (alpha >= 0.5)
           -> exact Euclidean signed distance field (Felzenszwalb-Huttenlocher)
           -> glyph height via the same profile semantics as the SDF path
           -> normals/lighting/caster field/cast shadows
```

- `MaskSource`: a raster of alpha values mapped onto `SurfaceNode.size`;
  `Shape = { kind: "mask", mask }`. Rasterization (canvas text, icons, ...)
  stays OUTSIDE the renderer. `alpha` is IMMUTABLE: the SDF is cached per
  mask object; do not mutate the array after use.
- **SDF boundary semantics**: distances are measured to the actual
  silhouette boundary, not to opposite-class pixel centers. The EDT grid is
  padded with virtual transparent pixels so ink touching the raster edge has
  a proper outer boundary, and a half-pixel correction places `d = 0`
  exactly on the boundary between ink and empty (or on the raster edge).
- **mapping contract**: the mask mapping must be ISOTROPIC
  (`size.x / size.y == mask.width / mask.height`, validated by
  `createScene`) so the SDF scales uniformly into scene units.
- `maskSurfaceHeight`: maps scene positions to mask pixels, bilinearly
  samples the SDF, and applies the surface profile. Coverage = `distance <
  0`, identical to the rounded-rect path. `surfaceHeight` dispatches on the
  shape kind for composition (SDF + mask in one scene).
- **elevation semantics (#13)**: glyph `elevation` is the base z. A relief
  attached to a button whose top is z=6 uses base z=6 with `thickness` as
  the relief amount (e.g. top z = 6.8).
- glyph elevation raises the relief above the button top and changes the
  shadow geometry; the cast shadow follows the silhouette (open counters
  show as lit gaps in the shadow; enclosed counters are reflected in the
  geometry). Thin reliefs cast short shadows — a smaller shadow `bias` is
  appropriate for them (the default 0.5 suits taller geometry).
- the demo renders PLAY text and a ring icon rasterized via canvas on the
  same pipeline.

## Multi-surface scenes (#18)

- `composeHeightField` / `composeSdfHeightField` merge any number of
  surfaces into one height field: `Hscene = max(0, max_i H_i)` with the
  topmost owner recorded in `objectId` (surface index) and `materialId`
  (material index); exact f32 ties go to the later surface (DOM-like paint
  order, `tieBreak: "first"` inverts).
- **Elevation policy**: `SurfaceNode.elevation` is ABSOLUTE scene z in the
  renderer contract (fixed in #13). Parent-relative elevations are an
  API-layer concept (#20/#21) and must be resolved to absolute z before a
  scene reaches the renderer.
- **castsShadow / receivesShadow**: the shadow pass samples a DEDICATED
  caster-only height field (`composeCasterHeightField`), composed from
  surfaces with `castsShadow = true` only. Non-casting top surfaces never
  hide lower casting surfaces at the same (x, y), and caster boundaries
  follow the bilinear height semantics (a casting/non-casting boundary
  sampled between texel centers interpolates, it is not owner-classified).
  Receiver z comes from the full visible height field; receiver ownership
  from the full objectId buffer, so a surface with `receivesShadow = false`
  keeps visibility 1 on its pixels. The base plane always casts and
  receives.
- **Height-field constraints** (MVP): a single height value per (x, y) cannot
  represent overhangs, caves, or multiple z-surfaces stacked at the same
  position. The topmost surface wins at each pixel; shadow caster/receiver
  information is derived from the topmost height field. These geometries are
  documented as unsupported.
- debug views: composed height, object/material ownership
  (`toCategoryRgba`), shadow mask, final color. The demo page renders a
  panel / button / badge three-layer scene.

## Cast shadows (#17)

```
height -> per-pixel ray march toward the light -> hard 0/1 visibility mask
```

- `computeVisibility`: from each pixel center, march `P.xy + L.xy * t` while
  the ray stays inside the scene and below `maxHeight + bias`; the pixel is
  occluded when a bilinear height sample exceeds the f32 threshold
  `f32(rayZ + bias)`. Sampling is bilinear with clamped (replicate)
  texture-boundary policy. Defaults: `stepSize = 0.5`, `bias = 0.5`
  (self-shadow acne).
- `prepareShadowContext` computes the pass-wide state (maxHeight, sanitized
  options, light data) once; every pixel trace shares it.
- default `maxDistance = sceneDiagonal / |L.xy|`: `t` advances along the
  normalized 3D light vector while XY advances by only `|L.xy| * t`, so a
  scene-diagonal XY traversal needs `sceneDiagonal / |L.xy|`. A near-vertical
  light falls back to the scene diagonal (its rays terminate via the
  maxHeight early exit or the bounds check).
- `traceShadowRay` (single ray summary) and `marchShadowRay` (all marched
  samples, including the blocking one) power tests and the demo ray
  visualization.
- visibility scales the direct (diffuse + specular) terms in the lighting
  pass; fully shadowed pixels keep only their ambient base color.
- This is a real visibility test on the height field — `box-shadow` /
  `drop-shadow` / translated silhouettes are never used.
- Soft shadows (#41): a finite apparent light size (`angularRadius > 0`)
  samples a deterministic golden-angle disk cone around the center direction
  per texel and writes the lit fraction `visibleRayCount / sampleCount` as a
  continuous visibility scalar. Sample counts are restricted to the dyadic
  set `{1, 4, 8, 16}` so every fraction is exactly representable.
- Decorrelated sampling (#43): neighboring texels select one of 8
  precomputed f32 rotations of the disk pattern through a stateless integer
  hash of their render texel coordinates (mirrored exactly in CPU and WGSL),
  so the sampled shadow silhouettes become spatially decorrelated sampling
  error instead of layered hard shadows.
- Edge-aware reconstruction (#43): on the soft path the raw visibility field
  passes through a small gated box filter (`reconstructVisibility` /
  `ReconstructionPass`) before lighting/presentation. The filter uses fixed
  uniform weights with height and ownership edge gates — it never creates
  the penumbra shape (the #41 ray geometry does) and never enlarges the
  footprint beyond its radius. Hard-path frames (and `enabled: false`)
  bypass it, preserving every historical {0, 1} byte. The raw field stays
  available for debugging and parity (`reconstructionActive` on the pipeline
  frame stats reports which field lighting consumed).

### Resolution / devicePixelRatio contract

This CPU reference assumes **1 texel = 1 CSS scene unit**: texel `(x, y)`
samples the height field at scene position `(x + 0.5, y + 0.5)`. A DPR-scaled
backend renders into a buffer of `width = floor(sceneWidth * dpr)` texels and
maps texel centers to scene coordinates via `sceneX = (texelX + 0.5) / dpr`,
`sceneY = (texelY + 0.5) / dpr`, with the receiver z unchanged (scene units).
`stepSize`, `bias` and `maxDistance` stay in scene units, so the shadow result
is resolution-independent — only the sampling density changes with dpr.

The demo page renders roughness low/high, metallic 0/1 and the
silicone / matte / metal presets side by side under identical geometry and
light, with the interactive light direction sliders.

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

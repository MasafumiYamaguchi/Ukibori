# Emissive illumination and bloom

Stacked on the emissive material PR (#69), which in turn depends on height profiles
(#65). Issue #12 is excluded. No ABI change beyond the emissive PR's ABI v4.

## Controls and rendering

`CompositeOptions.emissive` is available in the renderer pipeline, DOM
`setCompositing`, and React `compositing`. Omitted effects preserve the existing
render path and allocate no effect buffers. Material emission itself remains
available without either effect.

| Control | Default when enabled | Bounds / units |
| --- | --- | --- |
| `illumination.intensity` | 1 | 0–8 |
| `illumination.radius` | 48 | 0–256 scene units |
| `bloom.intensity` | 0.6 | 0–8 |
| `bloom.radius` | 24 | 0–128 scene units |
| `bloom.threshold` | 1 | 0–65504 exposed linear RGB peak |
| `quality` | 4 | 2–6, illumination grid half-width |

Invalid numbers fall back to defaults. DOM lengths are scaled from CSS pixels
through the same similarity transform as scene geometry; threshold, exposure and
intensities never scale. The DOM overlay region expands to contain the configured
effect radii, subject to the containing element's normal CSS clipping.

Illumination samples visible emitters on a fixed scene lattice, applies receiver
normal/distance attenuation and four intermediate height checks, and adds a
base-color-modulated diffuse contribution. Fixed source samples avoid translated
silhouette bands as receivers move across the screen. Virtual sources are lifted
by 15% of the radius to approximate lateral spill from this height-field model.

Bloom extracts emission after exposure and thresholding, then performs full
resolution horizontal and vertical Gaussian filtering (sigma = radius / 3).
A sparse Gaussian gather was rejected after browser inspection revealed visible
bands around silhouettes. Both filters zero-pad outside the render extent.

The GPU uses one illumination/composition dispatch and, when bloom is enabled,
two additional compute dispatches. A final presentation flag consumes the already
premultiplied result. No GPU-to-CPU readbacks occur in normal rendering. All passes
fit the existing minimum of eight storage bindings per shader stage. Intermediate
buffer sizes are checked against device limits before effects are submitted.

The CPU fallback mirrors the same passes. Transparent background glow uses bounded
premultiplied overlay colors (`alpha >= max(rgb)`) so colored halos survive normal
browser composition. CPU canvas output is converted to straight alpha at the DOM
boundary. Effects consume HDR emission, while reflected light and the first
illumination composition have already been quantized to the existing RGBA8 output.

## Retention and cost

Controls invalidate presentation only in the renderer pipeline. Emission changes
retain geometry/normals/shadows and execute upload, lighting and presentation.
Effects are recomputed over the full display field after geometry changes, including
partial upstream updates, so glow beyond a dirty geometry region is refreshed.
`present()` reuses the last effect result; disabling effects returns to raw lighting.
Effect buffers are retained for reuse and destroyed with the pipeline.

GPU profiler presentation timings span effects plus the render pass. Counters
include additional dispatches, submissions, allocations and parameter uploads.
Illumination needs an additional 4 bytes per pixel and a 64-byte uniform. Bloom adds
20 bytes per pixel (RGBA32F horizontal intermediate plus RGBA8 final output) and
another 64-byte uniform. Bloom work scales with radius in device pixels; illumination
work scales with `(2 * quality + 1)^2`, with samples outside its disk skipped. CPU
fallback can be costly on large overlays; keep radii and quality modest there.

## Limits

This is an opt-in screen-space approximation, not global illumination. Only the
visible height-field owners emit. Thin sources can be missed by the illumination
lattice, and thin blockers can be missed by the four height checks. Height-based
blocking treats visible geometry as opaque; it does not model transmission or
honor the separate direct-light `castsShadow`/`receivesShadow` flags. Material
metallicity does not alter the approximate spill response. Bloom includes emission
only, not reflected highlights. The overlay cannot perform physically additive
blending against arbitrary page content. Effect-source emission and exposure are
each capped at 65504 for bounded arithmetic; self-emission retains the full f32
range implemented in #69.

## Validation

The shared real-adapter harness compares CPU and GPU output for independent bloom,
illumination, both effects, threshold rejection, exposure zero, blockers, different
sample qualities, fractional radii and DPR 1 / 1.5 / 2. The tolerance is one RGBA8
level for floating-point portability. See `packages/renderer/emissive-effects-validation.json`
for measured results. Unit tests cover halo alpha, HDR thresholding, direction and
height occlusion, device-space scaling, retained updates and React control changes.
Existing CPU golden files are not regenerated.

Final results: renderer 1096, DOM 161 and React 209 tests passed; full workspace
build and typecheck passed; historical CPU golden digests are unchanged. Native
Dawn and Chromium 153.0.8010.0 each passed 72 effect cases (801,792 RGBA8 bytes,
maximum observed error 0) and five actual pipeline/presentation transitions.
The native runner also rechecked the 126 self-emission cases from #69.

The 903 × 288 demo rendered on WebGPU without fallback and was visually checked
at emission 0, 2 and 4. Linux software-GPU canvas verification used matching Vulkan
ANGLE/Dawn paths (`--use-angle=vulkan --enable-features=Vulkan
--disable-vulkan-surface`); an initial mixed OpenGL/Vulkan setup could not allocate
a shared canvas image and was corrected. This is a validation environment setting,
not an application requirement. These software-adapter results do not establish
hardware GPU performance.

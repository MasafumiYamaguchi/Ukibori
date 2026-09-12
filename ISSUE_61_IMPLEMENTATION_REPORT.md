# #61 — Raised and inset boundary profiles

## API and exact geometry

```ts
profile: { kind: "smooth" }                    // raised (default mode)
profile: { kind: "concave", mode: "inset" }   // carve a recess
profile: { kind: "power", exponent: 2.5, bias: "out", mode: "inset" }
```

`bevelWidth` is the inward transition width in scene units; `thickness` is
the non-negative raised height or inset depth. `elevation` is the absolute,
non-negative reference plane. DOM lengths are still scaled by DPR once;
exponent, direction and bias are dimensionless.

For signed distance `d < 0`, let `t = clamp(-d / bevelWidth, 0, 1)`:

| Kind | Normalized magnitude f(t) |
| --- | --- |
| `step` / legacy `flat` | 1 inside; 0 at/outside boundary |
| `linear` | t |
| `smooth` / legacy `bevel` | 3t² − 2t³ |
| `convex` | t² (gentle then steep) |
| `concave` | 1 − (1 − t)² (steep then gentle) |
| `power`, bias `in` (default) | tᵖ |
| `power`, bias `out` | 1 − (1 − t)ᵖ |

Smooth evaluation retains the old `1 - smoothstep(1-t)` operation order to
preserve the existing goldens. Width zero degenerates to step for every
curve. Power exponent must remain positive and finite after f32 rounding;
invalid modes/biases/exponents are rejected and scene creation canonicalizes
the exponent to f32. There are no user JavaScript callbacks.

Raised candidate height: `elevation + thickness * f(t)`.
Inset candidate height: `max(0, elevation - thickness * f(t))`.

## Ordered composition

Process `scene.surfaces` in array order, starting at the ownerless world
floor z=0. A raised surface applies max, retaining the original last-wins
f32 tie rule. An inset applies min and takes object/material ownership only
when it strictly lowers existing geometry. Equal-height cutters do not
steal ownership; an inset alone cannot create a surface on empty floor.

Thus `chassis → inset → knob` leaves a knob above the well, while placing
the inset last can cut the knob too. This is a height-field clipping
operation, not general CSG. The candidate also caps earlier geometry above
the reference plane: even zero depth can clip a taller earlier surface to
that plane. Reference height is explicit, not parent-relative.

All inset modifiers also lower the independently composed caster field,
including when `castsShadow: false`. That flag still controls additive
casting for raised surfaces; it cannot disable removal of geometry.
Non-casting raised surfaces retain the old behavior of leaving lower
casters visible to the shadow marcher. No phantom original chassis caster
remains above a recess. Bottom material and receivesShadow policy come
from the successful cutter's ownership.

## GPU, invalidation and cost

ABI v3 uses the existing 128-byte surface record: profile enum 0..5,
f32 power exponent at offset 44, inset flag bit 2, power-out flag bit 3.
Other padding remains zero and validation rejects non-power exponent/bias
payloads. ABI v1/v2 bytes must be re-encoded. Existing scene descriptors
remain compatible (`flat`/`bevel` aliases and raised default).

CPU and WGSL use the same shape-independent curve definitions and ordered
composition. No additional compute pass, texture, readback or record-size
increase is introduced. Only power profiles evaluate pow. Existing exact
byte invalidation includes profile mode/exponent/bias; light/material-only
changes retain geometry. Partial candidate bins preserve original order.
React's retained-options key now includes mode, exponent and bias.

## Verification

- Workspace build and typecheck; full renderer/DOM/React regression suites.
- Deterministic curve samples at t=0, .25, .5, .75, 1 and legacy alias checks.
- CPU tests for floor clamping, ordering, ties, ownership, non-casting
  cutters, later raised controls, and identical mask/rounded-rectangle math.
- Partial-region test covers every changed height/caster texel and retains
  candidate order; light/material-only encoding does not invalidate height.
- React regression updates exponent, bias and mode on the same entry.
- All six height WGSL modules compile and form pipelines under Dawn.
- **Executed WebGPU via Dawn / SwiftShader 5.0.0 (software Vulkan): 156
  curve/mode/shape/DPR fixtures passed.** Height/caster maximum error
  0.0000047684; normal maximum error 0.0000020862 (limits 0.0001). Object,
  material and coverage buffers match exactly. Two dedicated stable hard
  shadow fixtures match exactly. The broader curve matrix contains legitimate
  razor-edge binary shadow thresholds; exact visibility is asserted only on
  the dedicated fixtures, with the existing ±0.0005 stability precheck.
- Real Chromium comparison page checked for rounded rectangle, mask cross
  and SVG gear, including lighting/height/normals/visibility and cross-sections.
- Real Chromium WebGPU additionally passed **78 SVG-gear curve/mode/DPR
  fixtures** through `runProfileParity` with a browser-rasterized Float32
  mask. Maximum height/caster error 0.0000057221; normal 0.0000022948.

The SVG check exposed an existing CPU mask EDT bug: its in-place evaluation
overwrote parabola seed costs before later outputs consumed them. The fix
preserves envelope costs in reusable per-transform scratch storage. A new
independent brute-force boundary-segment oracle checks 40 irregular masks;
the existing CPU goldens remain unchanged. This correction is necessary for
the arbitrary SVG silhouettes in #61, rather than a change to profile math
or a relaxation of parity tolerances.

Final full regression before that additional oracle test: renderer 1,084,
DOM 161, React 207 passed, plus development-loop checks. The mask fix also
passed the full renderer suite; the added mask/profile targeted suite and
final build/typecheck were rerun after it.

Native parity reproduction (optional `webgpu` package required):

```sh
npm run test:profiles:webgpu -w ukibori-renderer
```

Alternatively set `UKIBORI_WEBGPU_MODULE` to an installed `webgpu/index.js`.
For a software Vulkan driver, set `VK_ICD_FILENAMES` to its ICD JSON.
This runner requires a real executing adapter; null backend validation is
not counted as numeric parity. Hardware-specific performance is unmeasured.

## Demo and scope

Run `npm run dev` and open `/profile-debug.html`. The top row is raised;
the second row carves a chassis. Change silhouette or light direction;
the separate power slider updates the cross-section graph/sample table.
All variants keep the same material/light and use actual height-derived
normals and shadows. Narrow silhouettes need not reach the full plateau
when the transition width exceeds their available inward distance.

Full radial bowls/domes, displacement maps, interaction animation and
general CSG are not included. The default remains legacy bevel/smooth.
#12 is excluded from this task per the user's instruction; no merge is made.

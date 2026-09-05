# Shadow edge quality evidence artifacts (#53)

Committed evidence from `node scripts/shadow-edge-evidence.mjs`
(packages/renderer), the Phase 1 cause analysis + fix evaluation matrix for
Issue #53. The CPU oracle is bit-exact with the GPU for the RAW visibility
field (hard exact {0,1}, soft dyadic k/n), so the whole matrix runs in Node
against the production TypeScript functions; the adopted fixes were then
verified bit-exactly on a real WebGPU adapter (see the implementation
report, `UKIBORI_WEBGPU_PASS`).

## Layout

- `summary.json` — every (scenario, variant, dpr) case with per-cut metrics:
  50%-crossing zigzag (max/RMS texels from a fitted straight line),
  transition width (texels with visibility in (0.02, 0.98)), distinct
  intermediate levels, thin-feature preservation (minVis / area below 0.5).
- `*.csv` — per-row 50% crossings for the diagonal cases (raw vs shipped).
- `*-raw.ppm` — the RAW visibility field (P6 grayscale): hard = binary
  {0,1} staircase; soft = dyadic k/n speckle.
- `*-recon.ppm` — the SHIPPED reconstruction output for the case (soft:
  the value-bilateral kernel; hard: the ring-rule refinement).
- `*-legacybox.ppm` — the pre-#53 #43 gated-box reconstruction (the before
  reference for the soft comparison).
- `*-ring.ppm` — the shipped hard refinement (the after reference for the
  hard comparison).
- `*-presented.ppm` — the production compositor bytes
  (`compositeShadowPremultipliedStrengthBytes`) composited over white, i.e.
  what the canvas tint shows for that field.

Rejected candidate PPMs (subtexel coverage supersampling K=4/9, value-gated
reconstruction, ring-on-recon) are NOT committed; their measured metrics
remain in `summary.json` (the numbers that drove the rejection).

## Headline numbers

Hard (raw = exact binary staircase, transition width 0):

| case | raw transition texels | shipped refine | crossing deviation |
|---|---|---|---|
| diagonal/hard/dpr1 | 0 (0 levels) | 2 texel ramp, 1 level | zigzag 0/0 |
| diagonal/hard/dpr3 | 0 (0 levels) | 3-4 texel ramp, 2 levels | zigzag 0/0 |

Soft (raw = k/n speckle; comparison vs the pre-#53 gated-box recon):

| case | raw | legacy box recon | shipped bilateral |
|---|---|---|---|
| diagonal/soft8/dpr1 | zig 1.53/0.93, w 3.4 | zig 0.18/0.08, w 7.0 | zig 0.38/0.17, w 6.3 |
| diagonal/soft8/dpr2 | zig 4.27/1.11, w 7.6 | zig 3.85/0.41, w 13.7 | zig 0.88/0.26, w 11.1 |
| thin/soft8/dpr1 minVis | 0 (fully dark) | 0.38 (washed out, area 48) | 0.0006 (preserved, area 111 = raw) |
| glyph/soft8/dpr1 minVis | 0 | 0.22 (stroke washed) | 0.099 (stroke preserved, area 141 vs raw 133) |

The thin-band and glyph-stroke preservation (the shipped bilateral keeps
narrow dark bands at full strength where the box washed them toward 0.3-0.4)
is the primary accepted change; the dpr>=2 contour zigzag reduction is the
second. At dpr1 the two kernels are comparable (both sub-texel zigzag); the
bilateral is also ~1 texel narrower on average (no added softness).

# Issue #56 — CSS text pigment and retained conversion

## Result

Integrated the existing `codex/issue-56-css-text-color` implementation
(`edfe8bf`, `8b5db31`) onto master `11ad398`, preserving #59 bake boundaries
and #60 SVG raster footprint/cache semantics. The integration fixes the SVG
test fixtures for the new registry state and includes further regression
coverage and a focused conversion optimization.

Computed CSS sRGB becomes a scene-local material's linear baseColor exactly
once. The existing renderer material resolution and GPU encoding consume
that same material. Roughness, metallic, and IOR remain controlled by the
selected preset/custom material. No renderer shader, shadow reconstruction,
or public color API changes are required.

Unsupported or partially transparent computed colors leave the DOM visible
and exclude the glyph from physical geometry, ownership, and shadows.
Opaque recovery restores delegation. Ink suppression no longer overwrites
CSS `color`; text fill/stroke/shadow suppression remains managed and
edge-triggered. Masks remain alpha-only.

## Acceptance coverage

| Requirement | Evidence / status |
| --- | --- |
| Black, #111, white, gray, red, blue | Parser, scene-builder material tests; browser fixture includes red/blue/#111 |
| Presets and custom response preserved | Scene-builder tests cover silicone/matte/metal, custom roughness/metallic/IOR, unmodified source material |
| Single sRGB conversion, CPU/GPU transport | 18 color/preset combinations compare CPU-resolved values with GPU f32 material records |
| Runtime style/inherited/theme updates | Live computed-style read before scene construction; existing invalidation paths retained |
| Baked geometry and inherited color | New observer-driven test changes inherited alpha/color without remeasuring the baked glyph |
| Alpha/unsupported fallback and recovery | DOM-layer, scene-builder, parser, and browser fixtures |
| Ownership, accessibility, SSR | Existing DOM/React suites pass; repeated delegation transitions do not multiply suppression ownership |
| SVG and DPR | Latest SVG scene construction retained; SVG unit suite passes |
| Physical CPU/WebGPU rendered-pixel parity | **Not verified in this environment**; existing real-Chrome fixture extended by the original implementation remains available |

CSSOM-only stylesheet edits still require `layer.invalidate()` (or the
appropriate existing scheduling seam); no polling loop was added. The live
computed color is reread even when geometry is baked or unchanged.

## Performance

The DOM boundary caches only the latest parsed color per element in a
WeakMap, including unsupported/null results. Each call still reads live CSS;
unchanged strings reuse the immutable linear color without token arrays or
three sRGB transfer-curve evaluations. Changed color/alpha values replace the
cache entry, and failures clear it. Weak keys do not retain unmounted DOM.

Reproduce:

```sh
node packages/ukibori-dom/scripts/bench-text-color.mjs
```

Node v24.19.0, 100,000 reads per sample, 9 alternating-order rounds after
warmup: median uncached 86.300 ms; retained 2.035 ms (~42.4x for this isolated
operation). The benchmark stubs getComputedStyle in both paths to isolate
parsing/conversion. **This is not browser frame timing or an FPS claim.**

## Validation

- Full workspace build and typecheck passed after integration.
- Full existing suites passed: renderer 1,063; DOM 179; React 207 tests,
  plus the development-loop checks.
- Additional integration regressions: 105 tests passed across parser,
  scene builder, DOM layer, and SVG suites.
- After the conversion optimization: 97 tests passed across parser,
  scene builder, and DOM layer, including cache invalidation/recovery.
- `git diff --check` passed.
- Real Chrome/WebGPU execution is pending: no browser binary was present
  and the Playwright Chromium download timed out. Encoded-material tests
  are transport checks, not a substitute for real GPU execution.

Review/debug entry points: `packages/ukibori-dom/test-browser/dom-gpu.mjs`
(`runGlyphColorScenario`) and `npm run test:webgpu -w ukibori-dom` on a
machine with Chrome/WebGPU. This tests visible GPU color and fallback.

## Review boundary

#61 raised/inset slope profiles is not included. #12 and the existing
project workflow require review between Issues; this change is ready for
that review, with the real-browser validation limitation above.

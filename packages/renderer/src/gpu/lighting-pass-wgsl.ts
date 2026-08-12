import { WGSL_SCENE_BASE } from "./wgsl";

/**
 * #28 lighting-pass WGSL shader — the GPU-resident material/lighting stage.
 *
 * This is a SELF-CONTAINED compute module (one invocation per render texel)
 * that consumes the exact GPU-resident fields DIRECTLY — the #26 tightly
 * packed f32 xyz normal field (binding 4), the #25 u32 material-id field
 * (binding 3) and the #27 f32 visibility field (binding 5) — plus the exact
 * uploaded scene header (binding 1, read-only storage: light direction,
 * intensity, exposure, environment) and material table (binding 2,
 * `array<MaterialRecord>`), and writes three tightly packed outputs
 * (binding 6 diffuse f32, binding 7 specular f32, binding 8 packed RGBA8
 * color as `array<u32>`), all GPU-resident for #29. No intermediate or
 * color buffer is ever read back in normal execution.
 *
 * ## Pass bindings (group 0, owned by `LightingPass`)
 *
 * | binding | type   | meaning                                        |
 * |---------|--------|------------------------------------------------|
 * | 0       | uniform| LightingPassParams (16 bytes)                  |
 * | 1       | storage| sceneHeader: SceneHeader (exact uploaded #24    |
 * |         |        | header, read-only)                             |
 * | 2       | storage| materials: array<MaterialRecord> (exact #24     |
 * |         |        | table, read-only)                              |
 * | 3       | storage| materialId: array<u32> (#25 material-id field,  |
 * |         |        | read-only; NO_OWNER = base plane)              |
 * | 4       | storage| inNormal: array<f32> (#26 tightly packed xyz,   |
 * |         |        | read-only, bound DIRECTLY, never copied)       |
 * | 5       | storage| inVisibility: array<f32> (#27 visibility field, |
 * |         |        | read-only, bound DIRECTLY, never copied)       |
 * | 6       | storage| outDiffuse: array<f32> (read_write)            |
 * | 7       | storage| outSpecular: array<f32> (read_write)           |
 * | 8       | storage| outColor: array<u32> (read_write; packed RGBA8) |
 *
 * Storage budget: exactly 5 read-only + 3 output = 8 storage buffers per
 * stage — the WebGPU spec-minimum `maxStorageBuffersPerShaderStage` — plus
 * the uniform binding (which does not count). `LightingPass` validates
 * `maxStorageBuffersPerShaderStage >= 8` before any device call.
 *
 * ## LightingPassParams — 16 bytes, align 16, little-endian host packing
 *
 * | offset | size | field            | meaning                          |
 * |--------|------|------------------|----------------------------------|
 * | 0      | 4    | ambient (f32)    | effective ambient fill in [0, 1] |
 * |        |      |                  | (default 0.08, finite/f32-       |
 * |        |      |                  | sanitized and clamped)           |
 * | 4      | 4    | workgroupSize    | documented dispatch workgroup    |
 * |        |      | (u32)            | size                             |
 * | 8      | 4    | _pad0 (u32)      | 0                                |
 * | 12     | 4    | _pad1 (u32)      | 0                                |
 *
 * All other scene values (light direction/intensity, exposure, environment)
 * are read from the exact uploaded scene header. Offsets are pinned by
 * `lighting-pass.ts` (host) and by the Node contract tests.
 *
 * ## Fixed #16/#22/#28 semantics mirrored here (the oracle is
 * `packages/renderer/src/lighting.ts` — `shadePreparedFields`)
 *
 * Coordinates are +x right, +y down, +z toward the viewer; the encoded
 * normalized light direction points FROM the receiver TOWARD the light; the
 * fixed view direction is `V = (0, 0, 1)`.
 *
 * - `materialId == NO_OWNER` uses the fixed base material (baseColor 0.6,
 *   roughness 0.5, metallic 0, ior 1.5). A valid id indexes the uploaded
 *   `MaterialRecord`; an invalid non-sentinel id falls back to the base
 *   material (defensive; valid #25 output never emits one). For an empty
 *   logical material table the host binds the uploader's one-record ABI
 *   floor (MATERIAL_STRIDE) and the shader never reads it.
 * - Direct BRDF (#16, exactly): GGX/Trowbridge-Reitz NDF with
 *   `alpha = max(roughness^2, 1e-4)`; height-correlated Smith visibility
 *   `0.5 / (gv + gl)`; Schlick Fresnel at `V·H` (== H.z); dielectric F0
 *   `((ior - 1) / (ior + 1))^2`; metallic-workflow F0 mix; Lambert diffuse
 *   with `1 / PI`. Metals have no diffuse term (`1 - metallic`).
 * - The direct contribution is scaled by
 *   `lightIntensity * max(N·L, 0) * clamp(visibility, 0, 1)`; visibility
 *   affects only direct light. Ambient and environment remain visible in a
 *   cast shadow.
 * - Environment (#22, exactly): diffuse =
 *   `baseColor * (1 - metallic) * intensity * diffuseIntensity`; specular =
 *   `intensity * (F0 + (1 - F0) * (1 - roughness)^5) * specularIntensity`.
 * - Accumulation is overflow-safe saturated non-negative add/multiply
 *   (mirrors `saturatingAdd`/`saturatingMul`) so `0 * overflow` can never
 *   turn into NaN; the linear result is then multiplied by the encoded
 *   scene exposure (also saturated), clamped per channel to [0, 1], and
 *   sRGB-encoded with `floor(encoded * 255 + 0.5)` (mirrors JavaScript
 *   `Math.round` for non-negative channels). Alpha is 255.
 * - The degenerate half vector (`L = -V`, `hLen == 0`) yields no half
 *   vector and a zero direct BRDF with no NaN; the shader only forms the
 *   half-vector components inside the `hLen > 0` guard.
 * - Debug outputs mirror the CPU meanings exactly: `outDiffuse` is the raw
 *   `max(N·L, 0)`; `outSpecular` is `min(luminance(brdf.specular) * N·L *
 *   visibility, 1)` BEFORE light intensity.
 *
 * ## Output layout
 *
 * All three outputs are tightly packed row-major, 4 logical bytes per
 * texel; texel `(tx, ty)` lives at array index `ty * width + tx`:
 *
 * - diffuse: scalar f32 (one `array<f32>` element)
 * - specular: scalar f32 (one `array<f32>` element)
 * - color: packed RGBA8 as one `array<u32>` element — byte order R, G, B, A
 *   in little-endian readback (`r | (g << 8) | (b << 16) | 0xff000000`), so
 *   a LE `Uint8Array` view of the bytes yields `[R, G, B, A, ...]`.
 *
 * Production usage is `STORAGE | COPY_SRC | COPY_DST`, never mapped.
 */

/** Dispatch workgroup size for the lighting pass (documented, injected into WGSL). */
export const LIGHTING_WORKGROUP_SIZE = 64;

/** LightingPassParams uniform byte length (16 bytes, 16-byte aligned). */
export const LIGHTING_PARAMS_BYTE_LENGTH = 16;

/** Logical output bytes per render texel (diffuse/specular/color all 4). */
export const LIGHTING_OUTPUT_BYTES_PER_TEXEL = 4;

export const LIGHTING_PASS_WGSL = /* wgsl */ `
${WGSL_SCENE_BASE}
// #28 lighting pass params (16 bytes, align 16; offsets pinned by
// lighting-pass.ts)
struct LightingPassParams {
  ambient: f32,          //  0 effective ambient fill in [0, 1] (default 0.08)
  workgroupSize: u32,    //  4 documented dispatch workgroup size
  _pad0: u32,            //  8
  _pad1: u32,            // 12
}                        // size 16, align 16

const LIGHTING_WORKGROUP_SIZE: u32 = ${LIGHTING_WORKGROUP_SIZE}u;
const NO_OWNER: u32 = 0xffffffffu;
// Largest finite f32: the saturation bound of the #22 overflow-safe
// add/multiply (mirrors saturatingAdd/saturatingMul in math.ts).
const F32_MAX: f32 = 3.4028234663852886e+38;
const PI: f32 = 3.141592653589793;
// Regularized GGX alpha so roughness = 0 keeps a mirror-like lobe (#16).
const GGX_ALPHA_EPS: f32 = 1e-4;
// The #16 GGX denominator floor (same value as brdf.ts dGgx).
const GGX_DENOM_EPS: f32 = 1e-7;

@group(0) @binding(0) var<uniform> params: LightingPassParams;
// The exact uploaded scene header (read-only storage, never copied).
@group(0) @binding(1) var<storage, read> sceneHeader: SceneHeader;
// The exact uploaded ABI material table (read-only; empty logical tables
// bind the one-record ABI floor and are never read here).
@group(0) @binding(2) var<storage, read> materials: array<MaterialRecord>;
// #25 material-id field (u32 ABI material index or NO_OWNER).
@group(0) @binding(3) var<storage, read> materialId: array<u32>;
// #26 tightly packed f32 xyz normal triple per texel (12-byte stride).
@group(0) @binding(4) var<storage, read> inNormal: array<f32>;
// #27 f32 visibility field (read-only storage, bound DIRECTLY).
@group(0) @binding(5) var<storage, read> inVisibility: array<f32>;
// Tightly packed row-major outputs (4 logical bytes per texel).
@group(0) @binding(6) var<storage, read_write> outDiffuse: array<f32>;
@group(0) @binding(7) var<storage, read_write> outSpecular: array<f32>;
@group(0) @binding(8) var<storage, read_write> outColor: array<u32>;

// Overflow-safe saturated add: finite non-negative inputs yield a finite
// result <= F32_MAX (a sum that would overflow to +Infinity saturates).
fn satAdd(a: f32, b: f32) -> f32 {
  return min(a + b, F32_MAX);
}

// Overflow-safe saturated multiply: 0 * anything is 0 (never NaN), and a
// product that would overflow to +Infinity saturates to F32_MAX.
fn satMul(a: f32, b: f32) -> f32 {
  if (a == 0.0 || b == 0.0) {
    return 0.0;
  }
  return min(a * b, F32_MAX);
}

// #16 regularized GGX alpha, shared by NDF and geometry: a2 = alpha^2.
fn ggxAlpha(roughness: f32) -> f32 {
  return max(roughness * roughness, GGX_ALPHA_EPS);
}

// Dielectric F0 from IOR: ((ior - 1) / (ior + 1))^2 (#16).
fn dielectricF0(ior: f32) -> f32 {
  let v = (ior - 1.0) / (ior + 1.0);
  return v * v;
}

// Metallic-workflow F0: lerp(dielectric F0, baseColor, metallic) (#16).
fn f0ForMaterial(m: MaterialRecord) -> vec3<f32> {
  let f0d = dielectricF0(m.ior);
  return f0d + (m.baseColor - vec3<f32>(f0d)) * m.metallic;
}

// GGX / Trowbridge-Reitz NDF (#16, mirrors dGgx in brdf.ts).
fn dGgx(nDotH: f32, roughness: f32) -> f32 {
  let a2 = ggxAlpha(roughness) * ggxAlpha(roughness);
  let denom = max(nDotH * nDotH * (a2 - 1.0) + 1.0, GGX_DENOM_EPS);
  return a2 / (PI * denom * denom);
}

// Height-correlated Smith visibility (UE4 form, #16). Returns 0 when either
// cosine is <= 0. a2 <= 1 for every valid material (roughness in [0, 1]),
// so the sqrt argument is never negative.
fn smithGgxVisibility(nDotL: f32, nDotV: f32, roughness: f32) -> f32 {
  if (nDotL <= 0.0 || nDotV <= 0.0) {
    return 0.0;
  }
  let a2 = ggxAlpha(roughness) * ggxAlpha(roughness);
  let gv = nDotL * sqrt(nDotV * nDotV * (1.0 - a2) + a2);
  let gl = nDotV * sqrt(nDotL * nDotL * (1.0 - a2) + a2);
  let denom = gv + gl;
  if (denom > 0.0) {
    return 0.5 / denom;
  }
  return 0.0;
}

// Schlick Fresnel, per channel, at cosTheta = V·H (== H.z for V = (0,0,1)).
fn fresnelSchlick(cosTheta: f32, f0: vec3<f32>) -> vec3<f32> {
  let c = clamp(cosTheta, 0.0, 1.0);
  let t = pow(1.0 - c, 5.0);
  return f0 + (vec3<f32>(1.0) - f0) * t;
}

// CPU debug meaning of the specular output:
// min(luminance(brdf.specular) * NdotL * visibility, 1) BEFORE light
// intensity. The zero-factor early exit keeps a saturated (Inf) luminance
// from producing NaN via Inf * 0; the CPU oracle is f64-finite so the
// result is identical there.
fn specularOutput(specular: vec3<f32>, cosine: f32, vis: f32) -> f32 {
  if (cosine == 0.0 || vis == 0.0) {
    return 0.0;
  }
  return min(luminance(specular) * cosine * vis, 1.0);
}

fn luminance(v: vec3<f32>) -> f32 {
  return 0.2126 * v.r + 0.7152 * v.g + 0.0722 * v.b;
}

// Material ownership (#28): NO_OWNER = fixed base material; a valid id
// indexes the uploaded table; an invalid non-sentinel id falls back to the
// base material (defensive — valid #25 output never emits one).
fn baseMaterial() -> MaterialRecord {
  var m: MaterialRecord;
  m.baseColor = vec3<f32>(0.6, 0.6, 0.6);
  m.roughness = 0.5;
  m.metallic = 0.0;
  m.ior = 1.5;
  m.flags = 0u;
  m._reserved0 = vec4<f32>(0.0);
  m._reserved1 = vec4<f32>(0.0);
  return m;
}

fn materialFor(owner: u32) -> MaterialRecord {
  if (owner == NO_OWNER) {
    return baseMaterial();
  }
  if (owner < sceneHeader.materialCount) {
    return materials[owner];
  }
  return baseMaterial();
}

// Per-channel #22 linear accumulation with saturated arithmetic (mirrors
// accumulateLinear exactly):
//   satAdd(satAdd(satMul(base, ambient), satMul(satAdd(diff, spec), direct)),
//          satAdd(envDiffuse, envSpecular))
fn accumulateChannel(
  base: f32,
  brdfDiffuse: f32,
  brdfSpecular: f32,
  envDiffuse: f32,
  envSpecular: f32,
  ambient: f32,
  direct: f32,
) -> f32 {
  return satAdd(
    satAdd(satMul(base, ambient), satMul(satAdd(brdfDiffuse, brdfSpecular), direct)),
    satAdd(envDiffuse, envSpecular),
  );
}

// Exact sRGB transfer + Math.round mirror: clamp to [0, 1], encode, then
// floor(encoded * 255 + 0.5) — identical to JavaScript Math.round for the
// non-negative encoded channels (the gamma branch is >= ~0.04 here, so the
// u32 conversion can never see a negative value).
fn srgbEncodeChannel(v: f32) -> u32 {
  let c = clamp(v, 0.0, 1.0);
  let encoded = select(1.055 * pow(c, 1.0 / 2.4) - 0.055, c * 12.92, c <= 0.0031308);
  return u32(floor(encoded * 255.0 + 0.5));
}

// Pack R, G, B, A as one little-endian u32: readback yields bytes R, G, B, A.
// Alpha is always 255.
fn packRgba(r: u32, g: u32, b: u32) -> u32 {
  return r | (g << 8u) | (b << 16u) | 0xff000000u;
}

@compute @workgroup_size(LIGHTING_WORKGROUP_SIZE)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let g = gid.x;
  let width = sceneHeader.renderWidth;
  let height = sceneHeader.renderHeight;
  let texelCount = width * height;
  if (g >= texelCount) {
    return; // in-shader bounds guard
  }
  // #26 tightly packed f32 xyz normal triple at indices [g*3, g*3+1, g*3+2].
  let o = g * 3u;
  let nx = inNormal[o];
  let ny = inNormal[o + 1u];
  let nz = inNormal[o + 2u];
  // Encoded normalized light direction: FROM the receiver TOWARD the light.
  // +x right, +y down, +z toward the viewer; V = (0, 0, 1) is fixed.
  let lx = sceneHeader.lightDirection.x;
  let ly = sceneHeader.lightDirection.y;
  let lz = sceneHeader.lightDirection.z;
  let cosine = max(nx * lx + ny * ly + nz * lz, 0.0);
  let nDotV = max(nz, 0.0);
  // Debug output: raw max(N dot L, 0) (#28 contract).
  outDiffuse[g] = cosine;

  let owner = materialId[g];
  let m = materialFor(owner);
  let base = m.baseColor;
  // Visibility affects only the DIRECT terms; ambient/environment persist
  // in a cast shadow.
  let vis = clamp(inVisibility[g], 0.0, 1.0);

  // Fixed V = (0,0,1): half-vector length sqrt(|L|^2 + 2*L.z + 1). The
  // degenerate half vector (L = -V, hLen == 0) yields a zero BRDF with no
  // NaN: the half-vector components are only formed inside the guard.
  let hLen = sqrt(lx * lx + ly * ly + (lz + 1.0) * (lz + 1.0));
  var brdfDiffuse = vec3<f32>(0.0);
  var brdfSpecular = vec3<f32>(0.0);
  if (cosine > 0.0 && nDotV > 0.0 && hLen > 0.0) {
    let hx = lx / hLen;
    let hy = ly / hLen;
    let hz = (lz + 1.0) / hLen;
    let nDotH = max(nx * hx + ny * hy + nz * hz, 0.0);
    let nDotVH = hz; // V = (0,0,1) -> V·H == H.z
    let f = fresnelSchlick(nDotVH, f0ForMaterial(m));
    let d = dGgx(nDotH, m.roughness);
    let smithVis = smithGgxVisibility(cosine, nDotV, m.roughness);
    brdfSpecular = d * smithVis * f;
    // Lambert diffuse with 1/PI; metals have no diffuse term (1 - metallic).
    brdfDiffuse = (base * (vec3<f32>(1.0) - f) * (1.0 - m.metallic)) / PI;
  }
  outSpecular[g] = specularOutput(brdfSpecular, cosine, vis);

  // Direct contribution scaled by light intensity and visibility only.
  // Validated headers carry intensity >= 0; the max() guard is defensive.
  let intensity = max(sceneHeader.lightIntensity, 0.0);
  let direct = satMul(satMul(intensity, cosine), vis);

  // #22 shared environment (validated headers carry intensity >= 0 and
  // shares in [0, 1]; the clamps are defensive for f32-exact values).
  let envIntensity = max(sceneHeader.environment.x, 0.0);
  let diffuseShare = clamp(sceneHeader.environment.y, 0.0, 1.0);
  let specularShare = clamp(sceneHeader.environment.z, 0.0, 1.0);
  let f0 = f0ForMaterial(m);
  let t = pow(1.0 - m.roughness, 5.0);
  let diffuseScale = envIntensity * diffuseShare;
  let specularScale = envIntensity * specularShare;
  let envDiffuse = base * (1.0 - m.metallic) * diffuseScale;
  let envSpecular = specularScale * (f0 + (vec3<f32>(1.0) - f0) * t);

  // #22 saturated linear accumulation, then the exposure boundary, then the
  // exact sRGB encoder (floor(encoded * 255 + 0.5), alpha 255).
  let exposure = max(sceneHeader.exposure, 0.0);
  var linear = vec3<f32>(0.0);
  linear.r = accumulateChannel(base.r, brdfDiffuse.r, brdfSpecular.r, envDiffuse.r, envSpecular.r, params.ambient, direct);
  linear.g = accumulateChannel(base.g, brdfDiffuse.g, brdfSpecular.g, envDiffuse.g, envSpecular.g, params.ambient, direct);
  linear.b = accumulateChannel(base.b, brdfDiffuse.b, brdfSpecular.b, envDiffuse.b, envSpecular.b, params.ambient, direct);
  let exposedR = satMul(linear.r, exposure);
  let exposedG = satMul(linear.g, exposure);
  let exposedB = satMul(linear.b, exposure);
  outColor[g] = packRgba(
    srgbEncodeChannel(exposedR),
    srgbEncodeChannel(exposedG),
    srgbEncodeChannel(exposedB),
  );
}
`;

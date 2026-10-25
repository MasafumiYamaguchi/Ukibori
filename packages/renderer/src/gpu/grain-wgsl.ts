/** CPU twin: grain.ts. uint hash, smooth value noise, explicit low-pass fade. */
export const GRAIN_WGSL = /* wgsl */ `
struct ShadingRecord {
  material: MaterialRecord,
  origin: vec4<f32>,
}
fn grainHash(x: u32, y: u32, seed: u32) -> f32 {
  var h = (x * 0x1f123bb5u) ^ (y * 0x5f356495u) ^ seed;
  h = (h ^ (h >> 16u)) * 0x45d9f3bu;
  h = (h ^ (h >> 16u)) * 0x45d9f3bu;
  h = h ^ (h >> 16u);
  return f32(h & 65535u) / 65535.0;
}
fn grainLerp(a: f32, b: f32, t: f32) -> f32 { return a + (b - a) * t; }
fn grainRoughness(m: MaterialRecord, local: vec2<f32>, dpr: f32) -> f32 {
  let q = local / m.grainScale;
  let p = q - floor(q / 4096.0) * 4096.0;
  let cell = vec2<u32>(floor(p));
  let next = (cell + vec2<u32>(1u)) % vec2<u32>(4096u);
  let t = p - floor(p);
  let s = t * t * (3.0 - 2.0 * t);
  let n = grainLerp(grainLerp(grainHash(cell.x, cell.y, m.grainSeed), grainHash(next.x, cell.y, m.grainSeed), s.x),
    grainLerp(grainHash(cell.x, next.y, m.grainSeed), grainHash(next.x, next.y, m.grainSeed), s.x), s.y);
  let attenuation = clamp((m.grainScale * dpr - 1.0) / 3.0, 0.0, 1.0);
  return clamp(m.roughness + (n - 0.5) * m.grainStrength * attenuation, 0.0, 1.0);
}
`;

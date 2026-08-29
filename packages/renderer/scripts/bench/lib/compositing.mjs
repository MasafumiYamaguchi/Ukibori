// #46 CPU compositing benchmark stage: the final RGBA byte synthesis the
// presentation stage performs, using the PRODUCTION shared compositor
// helper (`compositeShadowPremultipliedStrengthBytes`) as the SINGLE source
// of truth — one call per base-plane texel, no duplicated shadow math.
//
//   - owned texel (owner !== NO_OWNER): lighting color RGB + alpha 255
//   - base-plane texel (NO_OWNER):    strength = clamp(1 - visibility),
//     the production helper's premultiplied bytes verbatim (visibility 1 ->
//     [0,0,0,0], visibility 0 -> the full-strength premultiplied shadow)
//
// The parity tests in bench-harness-contract.test.mjs pin this stage
// against the per-texel production oracle over a representative buffer.

export function cpuCompositeStage(api, composed, visibility, color, compositeOptions = {}) {
  const width = composed.height.spec.width;
  const height = composed.height.spec.height;
  const out = new Uint8Array(width * height * 4);
  const objectId = composed.objectId.data;
  const visibilityData = visibility.data;
  const colorData = color.data;
  const noOwner = api.NO_OWNER;
  for (let i = 0; i < objectId.length; i++) {
    const o = objectId[i];
    const p = i * 4;
    if (o === noOwner) {
      const strength = Math.min(1, Math.max(0, 1 - visibilityData[i]));
      const bytes = api.compositeShadowPremultipliedStrengthBytes(strength, compositeOptions);
      out[p] = bytes[0];
      out[p + 1] = bytes[1];
      out[p + 2] = bytes[2];
      out[p + 3] = bytes[3];
    } else {
      out[p] = colorData[p];
      out[p + 1] = colorData[p + 1];
      out[p + 2] = colorData[p + 2];
      out[p + 3] = 255;
    }
  }
  return out;
}
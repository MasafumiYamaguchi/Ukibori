// #46 presentation microbenchmark P1-P3 fragment shaders: generated with the
// CONFIGURED render width embedded as the indexing stride so the bench input
// and the GPU indexing can never drift (a hardcoded stride mis-indexes every
// non-default width). P0 is a constant-color fullscreen triangle with no
// input fields.

export const PRESENT_VS = `
  @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    var pos = array<vec2<f32>, 3>(
      vec2<f32>(-1.0, -3.0), vec2<f32>(3.0, 1.0), vec2<f32>(-1.0, 1.0));
    return vec4<f32>(pos[i], 0.0, 1.0);
  }
`;

export const PRESENT_FS_CONSTANT = `
  @fragment fn fs() -> @location(0) vec4<f32> {
    return vec4<f32>(0.2, 0.4, 0.6, 1.0);
  }
`;

/**
 * Generate the P1-P3 fragment shader for a specific render width. The
 * embedded stride MUST equal the bench input width; the harness never runs
 * the microbenchmark at a width different from the generated shader.
 */
export function presentFs(width, stage) {
  const stride = `${width}u`;
  if (stage === 1) {
    return `
      struct ColorField { data: array<vec4<f32>> }
      @group(0) @binding(0) var<storage, read> color: ColorField;
      @fragment fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
        let i = u32(pos.y) * ${stride} + u32(pos.x);
        return color.data[i];
      }
    `;
  }
  if (stage === 2) {
    return `
      struct ColorField { data: array<vec4<f32>> }
      struct OwnerField { data: array<u32> }
      @group(0) @binding(0) var<storage, read> color: ColorField;
      @group(0) @binding(1) var<storage, read> owner: OwnerField;
      @fragment fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
        let i = u32(pos.y) * ${stride} + u32(pos.x);
        let o = owner.data[i];
        var c = color.data[i];
        if (o == 0xffffffffu) { c = vec4<f32>(0.0, 0.0, 0.0, 0.0); }
        return c;
      }
    `;
  }
  return `
    struct ColorField { data: array<vec4<f32>> }
    struct OwnerField { data: array<u32> }
    struct VisField { data: array<f32> }
    @group(0) @binding(0) var<storage, read> color: ColorField;
    @group(0) @binding(1) var<storage, read> owner: OwnerField;
    @group(0) @binding(2) var<storage, read> vis: VisField;
    @fragment fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
      let i = u32(pos.y) * ${stride} + u32(pos.x);
      let o = owner.data[i];
      let v = vis.data[i];
      var c = color.data[i];
      if (o == 0xffffffffu) { c = vec4<f32>(0.0, 0.0, 0.0, v); }
      return c;
    }
  `;
}
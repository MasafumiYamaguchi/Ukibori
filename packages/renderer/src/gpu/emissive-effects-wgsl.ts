export const EMISSIVE_EFFECTS_WGSL = /* wgsl */ `
struct Params { width:u32, height:u32, quality:u32, materialCount:u32,
 dpr:f32, exposure:f32, lightIntensity:f32, lightRadius:f32,
 bloomIntensity:f32, bloomRadius:f32, threshold:f32, shadowAlpha:f32,
 shadowR:f32, shadowG:f32, shadowB:f32, pad:f32 }
@group(0) @binding(0) var<storage,read> colors:array<u32>;
@group(0) @binding(1) var<storage,read> owners:array<u32>;
@group(0) @binding(2) var<storage,read> materialIds:array<u32>;
@group(0) @binding(3) var<storage,read> heights:array<f32>;
@group(0) @binding(4) var<storage,read> normals:array<f32>;
@group(0) @binding(5) var<storage,read> materials:array<f32>;
@group(0) @binding(6) var<storage,read> visibility:array<f32>;
@group(0) @binding(7) var<storage,read_write> output:array<u32>;
@group(0) @binding(8) var<uniform> p:Params;
const NONE:u32=0xffffffffu;
fn emission(i:u32)->vec3<f32>{let m=materialIds[i];if(m>=p.materialCount){return vec3<f32>(0.0);}let a=m*16u+8u;return min(vec3<f32>(materials[a],materials[a+1u],materials[a+2u]),vec3<f32>(65504.0));}
fn baseColor(i:u32)->vec3<f32>{let m=materialIds[i];if(m>=p.materialCount){return vec3<f32>(0.6);}let a=m*16u;return vec3<f32>(materials[a],materials[a+1u],materials[a+2u]);}
fn encode(x:f32)->f32{let v=clamp(x,0.0,1.0);if(v<=0.0031308){return 12.92*v;}return 1.055*pow(v,1.0/2.4)-0.055;}
fn decode(v:f32)->f32{if(v<=0.04045){return v/12.92;}return pow((v+0.055)/1.055,2.4);}
fn inside(s:vec2<i32>)->bool{return all(s>=vec2<i32>(0))&&s.x<i32(p.width)&&s.y<i32(p.height);}
fn indexOf(s:vec2<i32>)->u32{return u32(s.y)*p.width+u32(s.x);}
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id:vec3<u32>){
 if(id.x>=p.width||id.y>=p.height){return;}
 let g=id.y*p.width+id.x;let xy=vec2<f32>(id.xy);let owned=owners[g]!=NONE;
 var light=vec3<f32>(0.0);
 let q=i32(p.quality);
 if(p.lightIntensity>0.0&&p.lightRadius>0.0){for(var ky=-q;ky<=q;ky++){for(var kx=-q;kx<=q;kx++){
  let gridStep=p.lightRadius*p.dpr/f32(q);
  let s=vec2<i32>(floor((floor(xy/gridStep)+vec2<f32>(f32(kx),f32(ky)))*gridStep+vec2<f32>(0.5)));
  let uv=(vec2<f32>(s)-xy)/(p.lightRadius*p.dpr);let r2=dot(uv,uv);if(r2>1.0){continue;}
  if(p.lightIntensity>0.0&&p.lightRadius>0.0&&r2>0.0){
   if(!inside(s)){continue;}
   let n=indexOf(s);if(owners[n]==NONE||owners[n]==owners[g]){continue;}
   let em=emission(n);if(em.r+em.g+em.b<=0.0){continue;}
   let dxy=(vec2<f32>(s)-xy)/p.dpr;let dz=heights[n]+p.lightRadius*0.15-heights[g];
   let delta=vec3<f32>(dxy,dz);let distance=length(delta);
   let cosine=max(0.0,dot(vec3<f32>(normals[g*3u],normals[g*3u+1u],normals[g*3u+2u]),delta)/max(distance,0.001));
   var blocked=false;
   for(var step=1;step<=4;step++){let t=f32(step)/5.0;let sxy=vec2<i32>(floor(xy+(vec2<f32>(s)-xy)*t+vec2<f32>(0.5)));let j=indexOf(sxy);
    if(owners[j]!=owners[n]&&owners[j]!=owners[g]&&heights[j]>heights[g]+dz*t+p.lightRadius*0.002){blocked=true;break;}}
   if(blocked){continue;}
   let area=(p.lightRadius/f32(q))*(p.lightRadius/f32(q));let factor=cosine*(1.0-r2)*area/(3.141592653589793*max(distance*distance,area));light+=em*factor;
  }
 }}}
 let glow=light*baseColor(g)*p.exposure*p.lightIntensity;
 let raw=unpack4x8unorm(colors[g]);var rgb=vec3<f32>(0.0);var alpha=1.0;
 if(owned){rgb=vec3<f32>(encode(decode(raw.r)+glow.r),encode(decode(raw.g)+glow.g),encode(decode(raw.b)+glow.b));}
 else{let a0=p.shadowAlpha*(1.0-clamp(visibility[g],0.0,1.0));rgb=min(vec3<f32>(1.0),vec3<f32>(p.shadowR,p.shadowG,p.shadowB)*a0+vec3<f32>(encode(glow.r),encode(glow.g),encode(glow.b)));alpha=max(a0,max(rgb.r,max(rgb.g,rgb.b)));}
 let bytes=vec4<u32>(floor(clamp(vec4<f32>(rgb,alpha),vec4<f32>(0.0),vec4<f32>(1.0))*255.0+vec4<f32>(0.5)));
 output[g]=bytes.r|(bytes.g<<8u)|(bytes.b<<16u)|(bytes.a<<24u);
}
`;

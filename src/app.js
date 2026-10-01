/* ============================================================================
   极光帷幕 · AURORA CURTAIN  —  单文件实时渲染（three.js + 自定义 GLSL）
   ----------------------------------------------------------------------------
   图层合成顺序：星空 → 山脉 → 极光(Additive) → 水面 → 倒影(Screen) → Bloom → HUD
   光影：全程自发光（emission）主导，极光即唯一光源，经 Bloom 间接照亮水面/山脊
   色彩：sRGB 工作流 + ACESFilmicToneMapping，exposure ≈ 1.0
   ========================================================================== */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import GUI from 'three/addons/libs/lil-gui.module.min.js';

/* ---------------------------------------------------------------- 规格常量 */
const SPEC = {
  aurora: { green: '#39ff8a', magenta: '#ff2d6f', speed: 0.22, octaves: 3 }, // 流速 0.15–0.30
  water: { base: '#05080a', roughness: 0.15, metalness: 0.0, tile: 4, waveSpeed: 0.08 },
  reflect: { fade: 30 },
  terrain: { color: '#0a0e0a' },
  stars: { count: 800, size: 0.05, color: '#ffffff', opacity: 0.6 },
  bloom: { threshold: 0.6, strength: 0.8, radius: 0.4 },
  camera: { period: 8.0 } // dolly / pan ease-in-out 周期
};

const params = {
  auroraSpeed: SPEC.aurora.speed,
  auroraIntensity: 0.50,
  hue: 0.0,
  waveSpeed: SPEC.water.waveSpeed,
  reflStrength: 0.75,
  reflFade: SPEC.reflect.fade,
  reflRipple: 0.07,
  reflBlend: 'Screen',
  ridgeGlow: 0.09,
  exposure: 1.0,
  bloomStrength: SPEC.bloom.strength,
  bloomRadius: SPEC.bloom.radius,
  bloomThreshold: SPEC.bloom.threshold,
  camMotion: 1.0,
  paused: false,
  showHUD: true
};

// 默认值快照 —— HUD 右下角那个「恢复默认」小箭头（快捷键 R）用它一键回位
const DEFAULTS = Object.freeze({ ...params });

/* --------------------------------------------------------- 共享 uniform 池 */
// 极光 / 天穹 / 倒影 / 山脊染色 共用的全局 uniform（GUI 改一次，全场景生效）
const G = {
  uTime: { value: 0 },
  uSpeed: { value: params.auroraSpeed },
  uIntensity: { value: params.auroraIntensity },
  uColA: { value: new THREE.Color(SPEC.aurora.green) },   // 荧光绿 #39FF8A
  uColB: { value: new THREE.Color(SPEC.aurora.magenta) }, // 品红/红 #FF2D6F
  uHue: { value: params.hue }
};

/* ------------------------------------------------------------ GLSL 公共库 */
// 3 阶 fbm（值噪声 + 五次平滑），用于极光帘幕褶皱
const GLSL_NOISE = /* glsl */`
float hash21(vec2 p){
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
// 3 阶 fbm（规格：2–3 阶）
float fbm3(vec2 p){
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++){
    v += a * vnoise(p);
    p = p * 2.03 + vec2(11.7, 5.3);
    a *= 0.5;
  }
  return v * 1.142857; // 归一化到 0..1
}
// 绕灰度轴旋转色相（彩虹色谱条驱动）
vec3 hueShift(vec3 c, float h){
  if (abs(h) < 0.0001) return c;
  const vec3 k = vec3(0.57735027);
  float a = h * 6.2831853;
  return c * cos(a) + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - cos(a));
}
`;

/* =========================================================== 极光帘幕 Shader
   uv.y 垂直拉伸 + 3 阶 fbm 生成帘幕褶皱；颜色 mix(green, magenta, noise)；
   顶/底 smoothstep 羽化；AdditiveBlending / transparent / depthWrite:false
   ------------------------------------------------------------------------- */
const AURORA_VERT = /* glsl */`
varying vec3 vWorld;
varying vec2 vUv;
void main(){
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const AURORA_FRAG = /* glsl */`
precision highp float;

uniform float uTime;
uniform float uSpeed;       // 帘幕流速 0.15 – 0.30
uniform float uIntensity;
uniform vec3  uColA;        // 绿 #39FF8A
uniform vec3  uColB;        // 品红 #FF2D6F
uniform float uHue;
uniform float uSeed;
uniform float uAlpha;
uniform float uBandY;       // 亮带世界高度（极光贴地最亮处）
uniform float uBandW;
uniform float uTopY;
uniform float uLowY;
uniform float uLowFade;

#ifdef REFLECTION
uniform sampler2D uNormalMap;   // 复用水面 normalMap
uniform vec2  uMapOffset;       // 与水面同步滚动
uniform float uMapScale;        // 世界坐标 → 波纹 uv
uniform float uRipple;          // 波纹 UV 扰动强度
uniform float uFadeDist;        // 距离衰减 1 - clamp(dist/uFadeDist)
uniform float uFloor;           // 远处保留的最低强度
#endif

varying vec3 vWorld;
varying vec2 vUv;

${GLSL_NOISE}

// 帘幕主体：垂直拉伸（v 方向低频）→ 竖条状褶皱 + 竖向条纹射线
float curtain(vec2 uv, float t, float seed, out float noiseMix){
  float w1 = fbm3(vec2(uv.x * 2.1 + seed * 17.0 + t * 0.085, uv.y * 0.40 - t * 0.045));
  float w2 = fbm3(vec2(uv.x * 4.7 - seed *  9.0 - t * 0.055, uv.y * 0.72 + t * 0.035));
  float warp = (w1 - 0.5) * 0.62 + (w2 - 0.5) * 0.26;   // 域扭曲：帘幕左右摆动
  vec2  p    = vec2(uv.x + warp, uv.y);

  float folds  = fbm3(vec2(p.x * 8.0 + t * 0.10, p.y * 0.20 - t * 0.02)); // 大褶皱（多条帘幕）
  float detail = fbm3(vec2(p.x * 16.0 + t * 0.06, p.y * 0.42 + t * 0.05));// 中频
  float striae = fbm3(vec2(p.x * 26.0 + t * 0.22, p.y * 0.25 - t * 0.16));// 竖向细射线
  float rays   = fbm3(vec2(p.x * 34.0 + t * 0.30, p.y * 0.10 - t * 0.06));// 极细光帘

  float body = folds * 0.86 + detail * 0.30;
  body = smoothstep(0.40, 0.90, body);                 // 收紧阈值 → 帘幕成条
  body *= mix(0.55, 1.30, striae) * mix(0.78, 1.22, rays);
  // 帘幕之间的暗隙（真实极光的多条帘幕结构）
  float gap = smoothstep(0.30, 0.64, fbm3(vec2(p.x * 4.5 + seed * 3.0 + t * 0.06, p.y * 0.18)));
  body *= mix(0.32, 1.0, gap) * clamp(detail * 3.4, 0.0, 1.3);   // 中频调制，避免整片糊亮
  body = clamp(body, 0.0, 1.0);
  noiseMix = clamp(folds * 0.95 + detail * 0.30, 0.0, 1.0);
  return pow(body, 1.15);
}

void main(){
  float t = uTime * uSpeed * 8.0;   // 时间驱动偏移

  vec2 uv = vUv;

#ifdef REFLECTION
  // ---- 水面倒影：翻转几何 + 波纹 UV 扰动 + 距离衰减 ----
  if (vWorld.y > -0.02) discard;                 // 只保留水面以下的镜像部分
  vec2 ruv  = vWorld.xz * uMapScale + uMapOffset;
  vec3 nrm  = texture2D(uNormalMap, ruv).xyz * 2.0 - 1.0;
  uv       += nrm.xy * uRipple;                  // uv += noise(uv * freq + time)
  float sh  = nrm.y;
  // 破碎镜像：按水深分条随机横移
  uv.x += (hash21(vec2(floor(vWorld.z * 0.32), floor(uTime * 0.6))) - 0.5) * 0.022;
#endif

  float noiseMix;
  float body = curtain(uv, t, uSeed, noiseMix);

#ifdef REFLECTION
  float yA = -vWorld.y;   // 还原到未镜像高度，保证明暗分布与主体一致
#else
  float yA =  vWorld.y;
#endif

  // ---- 垂直羽化（世界高度驱动：底缘较锐 + 向上指数拖尾 + 贴地羽化） ----
  float low  = smoothstep(uLowY, uLowY + uLowFade, yA);
  float edge = smoothstep(uBandY - 24.0, uBandY + 2.0, yA);
  float tail = exp(-max(0.0, yA - uBandY) / uBandW);
  float haze = exp(-abs(yA - uBandY) / (uBandW * 1.9));
  float vmask = low * (edge * tail + haze * 0.03);

  // ---- 水平/贴图边缘羽化 ----
  float xf = smoothstep(0.0, 0.12, uv.x) * (1.0 - smoothstep(0.88, 1.0, uv.x));
  float hf = smoothstep(0.0, 0.05, vUv.y) * (1.0 - smoothstep(0.95, 1.0, vUv.y));

  float alpha = min(body * vmask * xf * hf, 1.0);

  // ---- 颜色：绿 → 品红，按噪声值 + 高度 mix ----
  float cm = clamp(noiseMix * 0.40 + smoothstep(uBandY, uTopY * 0.46, yA) * 0.95, 0.0, 1.0);
  vec3 col = mix(uColA, uColB, cm);
  col += uColA * edge * exp(-max(0.0, yA - uBandY) / (uBandW * 0.5)) * (0.30 + 0.70 * noiseMix) * 0.22;
  col = hueShift(col, uHue) * uIntensity;

#ifdef REFLECTION
  // 水面交点距离 → 衰减（距相机越远越淡）
  vec3  C   = cameraPosition;
  float tt  = C.y / max(C.y - vWorld.y, 1e-4);
  vec3  hit = C + tt * (vWorld - C);
  float d   = length(hit.xz - C.xz);
  float fadeD = 1.0 - clamp(d / uFadeDist, 0.0, 1.0);
  float mirror = mix(uFloor, 1.0, fadeD) * smoothstep(1.5, 9.0, d);   // 近岸陡视角处压暗
  mirror *= mix(0.08, 1.0, smoothstep(-0.50, 0.35, sh));               // 横向条带破碎
  // Screen 混合：颜色预乘，alpha 由混合方程接管
  gl_FragColor = vec4(col * alpha * mirror * uAlpha * 0.68, 1.0);
#else
  gl_FragColor = vec4(col, alpha * uAlpha);
#endif
}
`;

/* =============================================================== 天穹 Shader */
const DOME_VERT = /* glsl */`
varying vec3 vDir;
void main(){
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const DOME_FRAG = /* glsl */`
precision highp float;
uniform vec3  uTop, uHorizon, uColA, uColB;
uniform float uTime, uGlow, uHue;
varying vec3 vDir;

${GLSL_NOISE}

void main(){
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = mix(uHorizon, uTop, smoothstep(-0.06, 0.60, h));
  // 地平线漫射辉光（极光作为唯一光源的“环境”部分）
  float band = exp(-pow((h - 0.010) / 0.028, 2.0));
  float n = fbm3(vec2(atan(d.z, d.x) * 1.7 + uTime * 0.012, h * 6.0 - uTime * 0.02));
  vec3 g = mix(uColA, uColB, smoothstep(0.30, 0.85, n));
  col += g * band * uGlow * (0.45 + 0.85 * n);
  col += g * exp(-pow((h - 0.055) / 0.150, 2.0)) * uGlow * 0.10 * n;
  gl_FragColor = vec4(hueShift(col, uHue), 1.0);
}
`;

/* =============================================================== 星空 Shader */
const STAR_VERT = /* glsl */`
attribute float aSeed;
attribute float aSize;
uniform float uTime, uSize, uGain, uPix;
varying float vA;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float dist = max(-mv.z, 1.0);
  float tw = 0.70 + 0.30 * sin(uTime * (0.5 + aSeed * 1.7) + aSeed * 41.0);
  gl_PointSize = clamp(uSize * uGain * uPix * aSize / dist, 1.0, 3.4);
  vA = tw * (0.55 + 0.45 * aSeed);
  gl_Position = projectionMatrix * mv;
}
`;

const STAR_FRAG = /* glsl */`
precision highp float;
uniform vec3 uColor;
uniform float uOpacity;
varying float vA;
void main(){
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  float a = pow(1.0 - r2, 2.4);
  gl_FragColor = vec4(uColor, a * uOpacity * vA);
}
`;

/* ============================================================ 工具函数 (JS) */
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const hash2 = (x, y) => {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return s - Math.floor(s);
};
const vnoise2 = (x, y) => {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
  const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
};
const fbm2 = (x, y, oct = 4) => {
  let v = 0, amp = 0.5, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) { v += amp * vnoise2(x * f, y * f); norm += amp; f *= 2.03; amp *= 0.5; }
  return v / norm;
};
const ridged = (x, y, oct = 4) => 1 - Math.abs(2 * fbm2(x, y, oct) - 1);

/* ================================================================ 渲染器 */
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.setClearColor(0x000000, 1);
renderer.toneMapping = THREE.ACESFilmicToneMapping;  // 输出前 ACES
renderer.toneMappingExposure = params.exposure;      // exposure ≈ 1.0
renderer.outputColorSpace = THREE.SRGBColorSpace;    // 色彩空间统一 sRGB

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x02060a, 0.00115);

/* --------------------------------------------------------------- 相机 */
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.5, 6000);
camera.position.set(0, 1.35, 14);

/* ================================================================ 天穹 */
const domeGeo = new THREE.SphereGeometry(1800, 48, 24);
const domeMat = new THREE.ShaderMaterial({
  vertexShader: DOME_VERT,
  fragmentShader: DOME_FRAG,
  side: THREE.BackSide,
  depthWrite: false,
  uniforms: {
    uTop: { value: new THREE.Color(0x000104) },
    uHorizon: { value: new THREE.Color(0x04090e) },
    uColA: G.uColA, uColB: G.uColB, uHue: G.uHue,
    uTime: G.uTime,
    uGlow: { value: 0.16 }
  }
});
const dome = new THREE.Mesh(domeGeo, domeMat);
dome.renderOrder = -100;
dome.frustumCulled = false;
scene.add(dome);

/* ================================================================ 星空 */
const STAR_COUNT = SPEC.stars.count;
const starGeo = new THREE.BufferGeometry();
{
  // 固定种子 LCG（seed = 20240930）→ 每次加载星图都一样，不会刷新一次换一片星空
  let s = 20240930 >>> 0;
  const srand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const pos = new Float32Array(STAR_COUNT * 3);
  const seed = new Float32Array(STAR_COUNT);
  const siz = new Float32Array(STAR_COUNT);
  for (let i = 0; i < STAR_COUNT; i++) {
    // 上半球壳分布，稀疏、低亮度
    const u = srand(), v = srand() * 0.94 + 0.02;
    const theta = u * Math.PI * 2;
    const phi = Math.acos(1 - v);              // 0..~π/2 偏天顶
    const r = 520 + srand() * 300;
    pos[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
    pos[i * 3 + 1] = r * Math.cos(phi) + 8;
    pos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    seed[i] = srand();
    siz[i] = 0.35 + srand() * 0.75;
  }
  starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  starGeo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  starGeo.setAttribute('aSize', new THREE.BufferAttribute(siz, 1));
}
const starMat = new THREE.ShaderMaterial({
  vertexShader: STAR_VERT,
  fragmentShader: STAR_FRAG,
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  uniforms: {
    uTime: G.uTime,
    uSize: { value: SPEC.stars.size },                 // 0.05
    uGain: { value: 26.0 },                            // 世界尺寸 → 像素增益
    uPix: { value: 1000 },
    uColor: { value: new THREE.Color(SPEC.stars.color) },
    uOpacity: { value: SPEC.stars.opacity }            // 0.6
  }
});
const stars = new THREE.Points(starGeo, starMat);
stars.renderOrder = -90;
stars.frustumCulled = false;
scene.add(stars);

/* ============================================================== 山脉剪影 */
const TERRAIN = { w: 3600, d: 900, seg: [420, 190], z: -410 };
const terrainGeo = new THREE.PlaneGeometry(TERRAIN.w, TERRAIN.d, TERRAIN.seg[0], TERRAIN.seg[1]);
terrainGeo.rotateX(-Math.PI / 2);
terrainGeo.translate(0, 0, TERRAIN.z);

function terrainHeight(x, z) {
  const dist = -z;                                        // 距相机纵深
  const ramp  = smoothstep(150, 430, dist);               // 近处沉入水下
  const ramp2 = smoothstep(430, 880, dist);
  const r1 = ridged(x * 0.00155, z * 0.00155, 4);
  const r2 = ridged(x * 0.00420, z * 0.00420, 4);
  const fine = fbm2(x * 0.014, z * 0.014, 4);
  let h = (r1 * 0.78 + r2 * 0.34) * 64 * ramp + ramp2 * 30 + fine * 3.4 * ramp;
  h *= 0.52 + 0.48 * smoothstep(0, 300, Math.abs(x));     // 中间留出峡谷走廊
  return h - 10.0;
}
{
  const p = terrainGeo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    p.setY(i, terrainHeight(p.getX(i), p.getZ(i)));
  }
  terrainGeo.computeVertexNormals();
}
const terrainMat = new THREE.MeshStandardMaterial({
  color: new THREE.Color(SPEC.terrain.color),   // 近黑 #0A0E0A
  roughness: 1.0,                                // 无高光
  metalness: 0.0,
  dithering: true
});
// 山脊仅顶部受极光微弱染色（自发光项，非布光）
terrainMat.onBeforeCompile = (sh) => {
  sh.uniforms.uColA = G.uColA;
  sh.uniforms.uColB = G.uColB;
  sh.uniforms.uTint = { value: params.ridgeGlow };
  terrainMat.userData.shader = sh;
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(position, 1.0)).xyz;');
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nuniform vec3 uColA;\nuniform vec3 uColB;\nuniform float uTint;')
    .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      float hn = clamp((vWPos.y - 4.0) / 58.0, 0.0, 1.0);
      vec3 tint = mix(uColA, uColB, clamp(0.02 + 0.30 * hn + 0.12 * sin(vWPos.x * 0.011), 0.0, 1.0));
      totalEmissiveRadiance += tint * pow(hn, 2.4) * uTint;`);
};
const terrain = new THREE.Mesh(terrainGeo, terrainMat);
terrain.renderOrder = -10;
scene.add(terrain);

/* ============================================== 水面波纹 normalMap（程序化） */
function makeWaterNormalMap(size = 512) {
  // 水平条带状波：波矢主要沿 v 方向 → 屏幕上呈横向条带
  const waves = [];
  let rnd = 1234.5678;
  const rand = () => { rnd = (rnd * 16807) % 2147483647; return rnd / 2147483647; };
  for (let i = 0; i < 22; i++) {
    const cyc = Math.max(2, Math.round(3 * Math.pow(1.34, i % 11)));
    const ang = Math.PI / 2 + (rand() - 0.5) * 0.62;       // 主要沿 v
    const kx = Math.round(Math.cos(ang) * cyc);
    const kv = Math.round(Math.sin(ang) * cyc) || cyc;
    waves.push({ kx, kv, amp: 1.0 / Math.pow(1.30, i), ph: rand() * Math.PI * 2 });
  }
  const data = new Uint8Array(size * size * 4);
  const TWO_PI = Math.PI * 2;
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      let dhdu = 0, dhdv = 0;
      for (let k = 0; k < waves.length; k++) {
        const w = waves[k];
        const c = Math.cos(TWO_PI * (w.kx * u + w.kv * v) + w.ph);
        dhdu += w.amp * w.kx * c;
        dhdv += w.amp * w.kv * c;
      }
      // 法线 = normalize(-dh/du, -dh/dv, 1)
      const sc = 0.010;
      let nx = -dhdu * sc, ny = -dhdv * sc, nz = 1.0;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len; nz /= len;
      const o = (y * size + x) * 4;
      data[o]     = Math.round((nx * 0.5 + 0.5) * 255);
      data[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      data[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(SPEC.water.tile, SPEC.water.tile);        // tile 4 × 4
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.needsUpdate = true;
  return tex;
}
const waterNormalTex = makeWaterNormalMap(512);

/* ================================================================= 水面 */
const WATER_SIZE = 1000;
const waterGeo = new THREE.PlaneGeometry(WATER_SIZE, WATER_SIZE, 48, 48);
waterGeo.rotateX(-Math.PI / 2);
waterGeo.translate(0, 0, -200);
const waterMat = new THREE.MeshStandardMaterial({
  color: new THREE.Color(SPEC.water.base),        // #05080a
  roughness: SPEC.water.roughness,                // 0.15
  metalness: SPEC.water.metalness,                // 0.0
  normalMap: waterNormalTex,
  normalScale: new THREE.Vector2(0.9, 0.9),
  dithering: true
});
const water = new THREE.Mesh(waterGeo, waterMat);
water.renderOrder = 20;
scene.add(water);

/* ============================== 光照：极光作为唯一光源（微弱环境 + 极弱主光） */
// 极光不直接“打光”：水面/山脊由倒影层、山脊自发光染色与 Bloom 间接照亮。
// 方向光强度压到接近 0 —— 低粗糙度水面上任何可观的平行光都会形成探照灯式
// 镜面光柱（GGX 峰值 ≈ 1/(π·α²)），与“全程自发光主导”的参考质感不符。
const hemi = new THREE.HemisphereLight(0x0d3a2b, 0x01030a, 0.30);
scene.add(hemi);
const auroraKey = new THREE.DirectionalLight(0x8effc0, 0.0);
auroraKey.position.set(-140, 55, -220);
auroraKey.color.copy(new THREE.Color(SPEC.aurora.green)).lerp(new THREE.Color(SPEC.aurora.magenta), 0.22);
scene.add(auroraKey);

/* ============================================================ 极光帷幕 */
const AURORA_LAYERS = [
  { w: 2400, h: 620, cy: 240, z: -820,  seed: 0.00, alpha: 1.00, speedK: 1.00, band: 80, bandW: 72, top: 560, lowFade: 34 },
  { w: 3200, h: 900, cy: 340, z: -1250, seed: 3.70, alpha: 0.24, speedK: 0.72, band: 110, bandW: 92, top: 640, lowFade: 60 }
];

function auroraUniforms(layer, isReflection) {
  const u = {
    uTime: G.uTime, uSpeed: G.uSpeed, uIntensity: G.uIntensity,
    uColA: G.uColA, uColB: G.uColB, uHue: G.uHue,
    uSeed: { value: layer.seed },
    uAlpha: { value: isReflection ? layer.alpha * params.reflStrength : layer.alpha },
    uBandY: { value: layer.band },
    uBandW: { value: layer.bandW },
    uTopY: { value: layer.top },
    uLowY: { value: 8.0 },
    uLowFade: { value: layer.lowFade }
  };
  if (isReflection) Object.assign(u, {
    uNormalMap: { value: waterNormalTex },
    uMapOffset: { value: new THREE.Vector2() },
    uMapScale: { value: SPEC.water.tile / WATER_SIZE },   // 与水面 tile 对齐
    uRipple: { value: params.reflRipple },
    uFadeDist: { value: params.reflFade },
    uFloor: { value: 0.07 }
  });
  return u;
}

const auroraGroup = new THREE.Group();
const mirrorGroup = new THREE.Group();      // scale.y = -1 → 垂直翻转镜像
mirrorGroup.scale.set(1, -1, 1);
scene.add(auroraGroup, mirrorGroup);

const reflectionMats = [];
const auroraMats = [];

for (const layer of AURORA_LAYERS) {
  const geo = new THREE.PlaneGeometry(layer.w, layer.h, 1, 1);

  const mainMat = new THREE.ShaderMaterial({
    vertexShader: AURORA_VERT,
    fragmentShader: AURORA_FRAG,
    uniforms: auroraUniforms(layer, false),
    transparent: true,
    blending: THREE.AdditiveBlending,   // 加性叠加
    depthWrite: false,                  // 不写深度
    side: THREE.DoubleSide
  });
  const main = new THREE.Mesh(geo, mainMat);
  main.position.set(0, layer.cy, layer.z);
  main.renderOrder = 10;
  auroraGroup.add(main);
  auroraMats.push(mainMat);

  const reflMat = new THREE.ShaderMaterial({
    vertexShader: AURORA_VERT,
    fragmentShader: AURORA_FRAG,
    defines: { REFLECTION: '' },
    uniforms: auroraUniforms(layer, true),
    transparent: true,
    depthWrite: false,
    depthTest: false,                   // 覆盖在水面之上（几何本身在水面以下）
    side: THREE.DoubleSide
  });
  setReflectionBlend(reflMat);
  const refl = new THREE.Mesh(geo, reflMat);
  refl.position.set(0, layer.cy, layer.z);
  refl.renderOrder = 30;
  mirrorGroup.add(refl);
  reflectionMats.push(reflMat);
}

// 倒影混合：Screen（默认，视亮度定） / Additive
function setReflectionBlend(mat, mode = params.reflBlend) {
  mat.blending = THREE.CustomBlending;
  mat.blendEquation = THREE.AddEquation;
  if (mode === 'Additive') {
    mat.blendSrc = THREE.OneFactor;
    mat.blendDst = THREE.OneFactor;
  } else {                                // Screen: src*(1-dst) + dst
    mat.blendSrc = THREE.OneMinusDstColorFactor;
    mat.blendDst = THREE.OneFactor;
  }
  mat.needsUpdate = true;
}
reflectionMats.forEach((m) => setReflectionBlend(m));

/* ============================================================ 后期处理 */
const composer = new EffectComposer(renderer);
composer.setSize(window.innerWidth, window.innerHeight);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  params.bloomStrength, params.bloomRadius, params.bloomThreshold   // 0.8 / 0.4 / 0.6
);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());   // ACES + sRGB 输出

/* ================================================================ HUD */
const hudCoords = document.getElementById('hudCoords');
const hudMid = document.querySelector('.hud-mid');
const gui = new GUI({ title: '极光帷幕 · AURORA', container: document.getElementById('guiHost') });

// ---- 主控 4 个滑块（画面底缘常驻）----
gui.add(params, 'auroraSpeed', 0.05, 0.40, 0.005).name('极光流速 speed')
  .onChange((v) => { G.uSpeed.value = v; });                       // 规格 0.15–0.30
gui.add(params, 'auroraIntensity', 0.3, 3.0, 0.01).name('极光亮度 emission')
  .onChange((v) => { G.uIntensity.value = v; });
gui.add(params, 'bloomStrength', 0.0, 2.5, 0.01).name('辉光强度 bloom')
  .onChange((v) => { bloomPass.strength = v; });
gui.add(params, 'exposure', 0.2, 2.5, 0.01).name('曝光 exposure')
  .onChange((v) => { renderer.toneMappingExposure = v; });

// ---- 水面 / 倒影 ----
const fWater = gui.addFolder('水面 WATER · 倒影 REFLECTION');
fWater.add(params, 'waveSpeed', 0.0, 0.30, 0.005).name('波纹流速 ripple');   // 规格 0.08
fWater.add(params, 'reflStrength', 0.0, 2.0, 0.01).name('倒影强度 refl').onChange((v) => {
  reflectionMats.forEach((m, i) => { m.uniforms.uAlpha.value = AURORA_LAYERS[i].alpha * v; });
});
fWater.add(params, 'reflFade', 5, 120, 1).name('倒影衰减 dist').onChange((v) => {   // 规格 30
  reflectionMats.forEach((m) => { m.uniforms.uFadeDist.value = v; });
});
fWater.add(params, 'reflRipple', 0.0, 0.15, 0.002).name('波纹扰动 ripple').onChange((v) => {
  reflectionMats.forEach((m) => { m.uniforms.uRipple.value = v; });
});
fWater.add(params, 'reflBlend', ['Screen', 'Additive']).name('倒影混合 blend').onChange((v) => {
  reflectionMats.forEach((m) => setReflectionBlend(m, v));
});
fWater.close();

// ---- 进阶 ----
const fAdv = gui.addFolder('进阶 ADVANCED');
fAdv.add(params, 'ridgeGlow', 0.0, 0.6, 0.01).name('山脊染色 ridge').onChange((v) => {
  if (terrainMat.userData.shader) terrainMat.userData.shader.uniforms.uTint.value = v;
});
fAdv.add(params, 'bloomRadius', 0.0, 1.5, 0.01).name('辉光半径 radius')
  .onChange((v) => { bloomPass.radius = v; });                     // 规格 0.4
fAdv.add(params, 'bloomThreshold', 0.0, 1.5, 0.01).name('辉光阈值 threshold')
  .onChange((v) => { bloomPass.threshold = v; });                  // 规格 0.6
fAdv.add(params, 'camMotion', 0.0, 2.0, 0.01).name('运镜幅度 dolly/pan');
fAdv.close();

/* ---------------------------------------- 彩虹色谱条 + 数值框（色相偏移） */
const hueRange = document.getElementById('hueRange');
const hueNum = document.getElementById('hueNum');
const hueKnob = document.getElementById('hueKnob');
function applyHue(v) {
  params.hue = v;
  G.uHue.value = v;
  hueKnob.style.left = (v * 100) + '%';
  if (hueRange.value !== String(v)) hueRange.value = String(v);
  if (document.activeElement !== hueNum) hueNum.value = v.toFixed(2);
}
hueRange.addEventListener('input', (e) => applyHue(parseFloat(e.target.value)));
hueNum.addEventListener('input', (e) => {
  const v = Math.min(1, Math.max(0, parseFloat(e.target.value) || 0));
  applyHue(v);
});
applyHue(0);

/* ------------------------------------------------------------- 交互开关 */
// 恢复默认：把所有 params 回位，并同步到 uniform / 材质 / 后期 / GUI 显示
function resetParams() {
  Object.assign(params, DEFAULTS);
  G.uSpeed.value = params.auroraSpeed;
  G.uIntensity.value = params.auroraIntensity;
  renderer.toneMappingExposure = params.exposure;
  bloomPass.strength = params.bloomStrength;
  bloomPass.radius = params.bloomRadius;
  bloomPass.threshold = params.bloomThreshold;
  if (terrainMat.userData.shader) terrainMat.userData.shader.uniforms.uTint.value = params.ridgeGlow;
  reflectionMats.forEach((m, i) => {
    m.uniforms.uAlpha.value = AURORA_LAYERS[i].alpha * params.reflStrength;
    m.uniforms.uFadeDist.value = params.reflFade;
    m.uniforms.uRipple.value = params.reflRipple;
    setReflectionBlend(m, params.reflBlend);
  });
  applyHue(params.hue);
  gui.controllersRecursive().forEach((c) => c.updateDisplay());
  document.body.classList.toggle('hud-hidden', !params.showHUD);
  const btn = document.getElementById('resetBtn');
  if (btn) {                       // 点一下转一圈，给个反馈
    btn.classList.add('spin');
    setTimeout(() => btn.classList.remove('spin'), 520);
  }
}

window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyH') {
    params.showHUD = !params.showHUD;
    document.body.classList.toggle('hud-hidden', !params.showHUD);
  } else if (e.code === 'KeyR') {
    resetParams();
  } else if (e.code === 'Space') {
    e.preventDefault();
    params.paused = !params.paused;
  }
});

const resetBtn = document.getElementById('resetBtn');
if (resetBtn) resetBtn.addEventListener('click', resetParams);

/* ------------------------------------------------------------ 尺寸自适应 */
function updateStarPixelScale() {
  const h = renderer.getDrawingBufferSize(new THREE.Vector2()).y;
  starMat.uniforms.uPix.value = (h * 0.5) / Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
}
function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
  composer.setSize(w, h);        // 内部会按 pixelRatio 同步各 Pass 的尺寸
  updateStarPixelScale();
}
window.addEventListener('resize', onResize);
updateStarPixelScale();

/* ------------------------------------------------------- 相机：8s 缓入缓出 */
const CAM = { x: 0, y: 1.35, z: 14 };
const camTarget = new THREE.Vector3();
function updateCamera(elapsed) {
  const m = params.camMotion;
  const ph = (elapsed / SPEC.camera.period) * Math.PI * 2;
  const dolly = 0.5 - 0.5 * Math.cos(ph);     // 0 → 1 → 0（ease-in-out）
  const pan = Math.sin(ph);                    // -1 → 1 → -1
  camera.position.set(
    CAM.x + pan * 1.9 * m,
    CAM.y + 0.10 * dolly * m,
    CAM.z + 3.4 * dolly * m
  );
  camTarget.set(pan * 0.7 * m, 3.1 + 0.35 * dolly * m, -40);
  camera.lookAt(camTarget);
}

/* ================================================================= 主循环 */
// 时间相位开关：打开 aurora-curtain.html?t=5.2 会把相位停在第 5.2 秒并暂停，
// 便于截图 / 对比 / 取帧（相机与极光都停在那一姿态）。
const QUERY = new URLSearchParams(location.search);
const PINNED_T = QUERY.has('t') ? Math.max(0, parseFloat(QUERY.get('t')) || 0) : null;
if (PINNED_T !== null) params.paused = true;

const clock = new THREE.Clock();
let elapsed = PINNED_T !== null ? PINNED_T : 0;
let fpsSmooth = 60;
let hudTimer = 0;
const sizeVec = new THREE.Vector2();

function frame() {
  const dtRaw = clock.getDelta();
  const dt = Math.min(dtRaw, 0.05);
  if (PINNED_T !== null) elapsed = PINNED_T;
  else if (!params.paused) elapsed += dt;
  fpsSmooth += ((dtRaw > 0 ? 1 / dtRaw : 60) - fpsSmooth) * 0.08;

  G.uTime.value = elapsed;
  updateCamera(elapsed);

  // 水面 normalMap 滚动（tile 4×4, speed 0.08）
  if (PINNED_T !== null) {
    // 时间相位被钉死时，波纹偏移取解析值而非逐帧累加 → 整帧完全确定
    waterNormalTex.offset.set(-PINNED_T * params.waveSpeed * 0.45, PINNED_T * params.waveSpeed);
  } else if (!params.paused) {
    waterNormalTex.offset.y += params.waveSpeed * dt;
    waterNormalTex.offset.x -= params.waveSpeed * dt * 0.45;
  }
  // 倒影复用同一张滚动 normalMap（保持波纹同步）
  reflectionMats.forEach((m) => m.uniforms.uMapOffset.value.copy(waterNormalTex.offset));

  // 天穹地平线辉光轻微呼吸（极光作为唯一光源的环境项）
  domeMat.uniforms.uGlow.value = 0.16 + 0.025 * Math.sin(elapsed * 0.35);

  composer.render();

  // HUD 文本（约 8Hz 刷新）
  hudTimer += dt;
  if (hudTimer > 0.12) {
    hudTimer = 0;
    renderer.getDrawingBufferSize(sizeVec);
    const sx = (camera.position.x >= 0 ? '+' : '−') + Math.abs(camera.position.x).toFixed(2);
    const sy = (camera.position.y >= 0 ? '+' : '−') + Math.abs(camera.position.y).toFixed(2);
    const sz = (camera.position.z >= 0 ? '+' : '−') + Math.abs(camera.position.z).toFixed(2);
    hudCoords.innerHTML =
      `<span><b>CAM</b>  X ${sx}  Y ${sy}  Z ${sz}</span>` +
      `<span class="l2">FPS ${PINNED_T !== null ? '--' : fpsSmooth.toFixed(1)}  ·  ${sizeVec.x}×${sizeVec.y}  ·  ${PINNED_T !== null ? 'PINNED t=' + PINNED_T : (params.paused ? 'PAUSED' : 'RUNNING')}</span>` +
      `<span class="l3">H 面板 · R 恢复默认 · SPACE 暂停</span>`;
  }
  requestAnimationFrame(frame);
}

/* --------------------------------------------------------------- 启动 */
const loading = document.getElementById('loading');
requestAnimationFrame(() => {
  frame();
  if (loading) loading.classList.add('gone');
});

// WebGL 上下文丢失兜底
canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  if (loading) { loading.textContent = 'WebGL 上下文丢失，请刷新页面'; loading.classList.remove('gone'); }
});

// 供调试：暴露关键对象
window.AURORA = {
  scene, camera, renderer, composer, bloomPass, params, G, SPEC, DEFAULTS, reset: resetParams,
  dome, domeMat, stars, starMat, terrain, terrainMat, water, waterMat,
  waterNormalTex, auroraGroup, mirrorGroup, auroraMats, reflectionMats,
  AURORA_LAYERS
};

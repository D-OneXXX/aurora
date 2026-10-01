# 极光帷幕 · 参数与实现说明（逐行取自成品源码当前状态）

> **本文件的每一个数值，都是从成品源码里直接读出来的，不是设计规格、也不是回忆。**
> 取值来源：`src/app.js`（834 行）、`src/shell.html`（193 行）；对应行号在 C 段逐条标注，可回查。
> 源码里不含随机项：噪声是自实现 hash、星空是固定种子 LCG、水面波纹是固定种子整数频率正弦，
> 所以同一台机器上重复打开，画面是稳定的，不会每次刷新都换个样子。

**怎么用**

| 你要什么 | 用哪一段 |
|---|---|
| 让 AI 按这套真实参数把这件作品重做一遍 | **A 段**（整段复制，一个代码块） |
| 生图模型出一张参考图 | **B 段**（只作质感与构图参考） |
| 核对某个参数到底是多少 | **C 段**（当前真实数值表 + 源码行号） |
| 排查"看着不对" | **D 段**（7 个翻车点：症状 → 病因） |
| 固定某一刻的画面 / 自查世界尺度 | **E 段**（`?t=` 截图开关 + 自检清单） |

---

## A 段 · 完整提示词（整段复制给 AI 智能体）

```text
请用 three.js 做单文件网页作品《极光帷幕 · AURORA CURTAIN》。下面每个数值、每条 GLSL、
每个 renderOrder 都是成品里真实生效的值，请逐字照做，不要"优化"、不要替换成你觉得更好看的参数。
最终产出一个自包含 HTML（three.js 内联，断网 file:// 双击可运行，不依赖 CDN）。

======================= 一、技术栈与渲染器 =======================
- three.js r160（ESM）+ EffectComposer / RenderPass / UnrealBloomPass / OutputPass
  + addons/libs/lil-gui.module.min.js
- WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
- setPixelRatio(Math.min(devicePixelRatio, 2))；setSize(w, h, false)
- toneMapping = ACESFilmicToneMapping；toneMappingExposure = 1.0
- outputColorSpace = SRGBColorSpace；setClearColor(0x000000, 1)
- scene.fog = new THREE.FogExp2(0x02060a, 0.00115)
  ★ 雾只作用于 MeshStandardMaterial（水面、山体）。帘幕/天穹/星空是自定义 ShaderMaterial
    且没接 fog chunk，不受雾影响 —— 这是刻意的（极光不该被雾压暗），别当成全局雾。
- 相机：PerspectiveCamera(55, w/h, 0.5, 6000)，初始位置 (0, 1.35, 14)

======================= 二、图层顺序与 renderOrder =======================
天穹 -100 → 星空 -90 → 山脉 -10 → 极光 10 → 水面 20 → 倒影 30 → Bloom → HUD
（three 先渲不透明物体再渲透明物体；水面是不透明的，所以极光/星空/倒影这些透明层
 天然排在水面之后。天穹 depthWrite:false 且不写深度，不会挡住后面的东西。）

======================= 三、极光帘幕 Shader（核心，逐字照做） =======================
公共 GLSL 库（三层共用：极光、天穹、倒影）：
  float hash21(vec2 p){
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float vnoise(vec2 p){
    vec2 i = floor(p), f = fract(p);
    vec2 u = f*f*f*(f*(f*6.0-15.0)+10.0);
    float a = hash21(i), b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }
  float fbm3(vec2 p){                       // 3 阶，lacunarity 2.03、gain 0.5
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 3; i++){ v += a * vnoise(p); p = p*2.03 + vec2(11.7, 5.3); a *= 0.5; }
    return v * 1.142857;                    // 归一化到 0..1
  }
  vec3 hueShift(vec3 c, float h){           // 绕灰度轴旋转色相；h=0 时恒等返回
    if (abs(h) < 0.0001) return c;
    const vec3 k = vec3(0.57735027);
    float a = h * 6.2831853;
    return c * cos(a) + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - cos(a));
  }

顶点着色器（主体与倒影共用同一份）：
  varying vec3 vWorld;
  varying vec2 vUv;
  void main(){
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }

帘幕函数（uv.y 垂直拉伸 + 域扭曲 + 多条帘幕暗隙）：
  float curtain(vec2 uv, float t, float seed, out float noiseMix){
    float w1 = fbm3(vec2(uv.x * 2.1 + seed * 17.0 + t * 0.085, uv.y * 0.40 - t * 0.045));
    float w2 = fbm3(vec2(uv.x * 4.7 - seed *  9.0 - t * 0.055, uv.y * 0.72 + t * 0.035));
    float warp = (w1 - 0.5) * 0.62 + (w2 - 0.5) * 0.26;
    vec2  p    = vec2(uv.x + warp, uv.y);
    float folds  = fbm3(vec2(p.x *  8.0 + t * 0.10, p.y * 0.20 - t * 0.02));
    float detail = fbm3(vec2(p.x * 16.0 + t * 0.06, p.y * 0.42 + t * 0.05));
    float striae = fbm3(vec2(p.x * 26.0 + t * 0.22, p.y * 0.25 - t * 0.16));
    float rays   = fbm3(vec2(p.x * 34.0 + t * 0.30, p.y * 0.10 - t * 0.06));
    float body = folds * 0.86 + detail * 0.30;
    body = smoothstep(0.40, 0.90, body);
    body *= mix(0.55, 1.30, striae) * mix(0.78, 1.22, rays);
    float gap = smoothstep(0.30, 0.64, fbm3(vec2(p.x * 4.5 + seed * 3.0 + t * 0.06, p.y * 0.18)));
    body *= mix(0.32, 1.0, gap) * clamp(detail * 3.4, 0.0, 1.3);
    body = clamp(body, 0.0, 1.0);
    noiseMix = clamp(folds * 0.95 + detail * 0.30, 0.0, 1.0);
    return pow(body, 1.15);
  }

主函数（时间与垂直分布）：
  float t = uTime * uSpeed * 8.0;            // uSpeed 默认 0.22
  vec2 uv = vUv;
  float noiseMix;
  float body = curtain(uv, t, uSeed, noiseMix);   // ★ alpha 用的是这个返回值（pow 之后），
                                                  //   不是函数内部 clamp 到 0..1 的中间量
  float yA = vWorld.y;                            // 倒影分支里改成 yA = -vWorld.y（见第四节）
  float low  = smoothstep(uLowY, uLowY + uLowFade, yA);        // 贴地羽化
  float edge = smoothstep(uBandY - 24.0, uBandY + 2.0, yA);    // 底缘（较锐）
  float tail = exp(-max(0.0, yA - uBandY) / uBandW);           // 向上指数拖尾
  float haze = exp(-abs(yA - uBandY) / (uBandW * 1.9));
  float vmask = low * (edge * tail + haze * 0.03);             // haze 系数就是 0.03
  float xf = smoothstep(0.0, 0.12, uv.x) * (1.0 - smoothstep(0.88, 1.0, uv.x));
  float hf = smoothstep(0.0, 0.05, vUv.y) * (1.0 - smoothstep(0.95, 1.0, vUv.y));
  float alpha = min(body * vmask * xf * hf, 1.0);              // ★ 必须 clamp 到 1

颜色（绿 → 品红，按噪声值 + 高度 mix，底部绿色亮核）：
  float cm = clamp(noiseMix * 0.40 + smoothstep(uBandY, uTopY * 0.46, yA) * 0.95, 0.0, 1.0);
  vec3 col = mix(uColA, uColB, cm);
  col += uColA * edge * exp(-max(0.0, yA - uBandY) / (uBandW * 0.5)) * (0.30 + 0.70 * noiseMix) * 0.22;
  col = hueShift(col, uHue) * uIntensity;                      // uIntensity 默认 0.50

材质：ShaderMaterial，transparent:true、blending:AdditiveBlending、depthWrite:false、
      depthTest 保持默认 true、side:DoubleSide。
每层几何：PlaneGeometry(w, h, 1, 1)（1×1 段即可，全部细节在片元里）。

两层帘幕（后者更远更淡，负责纵深）：
  层1：w=2400 h=620，position(0, 240, -820)， seed=0.00，uAlpha=1.00，
       uBandY=80，uBandW=72，uTopY=560，uLowY=8，uLowFade=34，renderOrder=10
  层2：w=3200 h=900，position(0, 340, -1250)，seed=3.70，uAlpha=0.24，
       uBandY=110，uBandW=92，uTopY=640，uLowY=8，uLowFade=60，renderOrder=10
  ★ 两层必须比山脉更远（山脉覆盖 z∈[-860,+40]），否则山脊挡不住帘幕底边，
    地平线会出现一条硬切直线。

======================= 四、水面倒影（同一份 shader + #ifdef REFLECTION） =======================
不要用 Reflector/CubeCamera。把上面同一份 shader【两层各挂一份镜像副本】，
放进一个 scale.y = -1 的镜像组（几何即关于 y=0 的真实镜像），副本 position 与主体一致，
renderOrder=30，depthTest:false（镜像几何在水面下方，必须盖在水面之上渲染）。

先厘清三件最容易猜错的事：
  (1) 镜像后 vUv 会上下翻转（PlaneGeometry 经 scale.y=-1 后，最低的片元拿到 vUv.y=1）。
      所以【垂直相关的一切只用还原后的世界高度 yA，绝不能用 vUv.y 判上下】；
      uv 只在取样噪声纹理时用，它跟着顶点走、不需翻转。
  (2) 公式末尾的 * 0.68 是「倒影整体亮度系数」，与 uAlpha 相乘后再交给 Screen 混合；
      uAlpha 是「层 alpha × 0.75」这个独立强度。两个都保留，不要合并、不要删。
  (3) uAlpha 是【替换】该层的 alpha（层1 = 1.00×0.75，层2 = 0.24×0.75），不是再乘一次。

片段里加这些（放在取样噪声之后、算 yA 之前）：
  if (vWorld.y > -0.02) discard;                    // 丢掉水面以上的镜像片元
  vec2 ruv = vWorld.xz * uMapScale + uMapOffset;    // uMapScale = 4/1000，uMapOffset 与水面同步
  vec3 nrm = texture2D(uNormalMap, ruv).xyz * 2.0 - 1.0;
  uv += nrm.xy * uRipple;                           // uRipple 默认 0.07
  float sh = nrm.y;
  uv.x += (hash21(vec2(floor(vWorld.z * 0.32), floor(uTime * 0.6))) - 0.5) * 0.022;   // 破碎横移
  float yA = -vWorld.y;                             // 还原未镜像高度，明暗分布才与主体一致

距离衰减与合成（dist 必须逐片元求"视线与水面交点"）：
  vec3  C = cameraPosition;
  float tt = C.y / max(C.y - vWorld.y, 1e-4);
  vec3  hit = C + tt * (vWorld - C);
  float d = length(hit.xz - C.xz);
  float fadeD = 1.0 - clamp(d / uFadeDist, 0.0, 1.0);          // uFadeDist 默认 30
  float mirror = mix(uFloor, 1.0, fadeD) * smoothstep(1.5, 9.0, d);        // uFloor = 0.07
  mirror *= mix(0.08, 1.0, smoothstep(-0.50, 0.35, sh));                   // 横向条带破碎
  gl_FragColor = vec4(col * alpha * mirror * uAlpha * 0.68, 1.0);          // 颜色预乘、alpha=1

混合（Screen，视亮度定，可切 Additive）：
  mat.blending = THREE.CustomBlending; mat.blendEquation = THREE.AddEquation;
  Screen:   blendSrc = OneMinusDstColorFactor; blendDst = OneFactor;    // src*(1-dst)+dst
  Additive: blendSrc = OneFactor;              blendDst = OneFactor;

======================= 五、水面 =======================
- PlaneGeometry(1000, 1000, 48, 48).rotateX(-Math.PI / 2).translate(0, 0, -200)
  （旋转是 -90° 躺平，不是 -180°；平移不可省。水面 y 恒为 0，覆盖 z∈[-700,+300]）
- MeshStandardMaterial：color #05080a、roughness 0.15、metalness 0.0、
  normalMap（见下）、normalScale (0.9, 0.9)、dithering true，renderOrder 20
- 程序化 normalMap（不要用贴图文件）：512×512 DataTexture；LCG 种子 rnd=1234.5678，
  rnd=(rnd*16807)%2147483647；22 条波，第 i 条：
    cyc = max(2, round(3 * 1.34^(i % 11)))
    ang = PI/2 + (rand()-0.5) * 0.62          // 波矢主要沿 v → 屏幕上呈水平条带
    kx  = round(cos(ang) * cyc)；kv = round(sin(ang) * cyc) || cyc
    amp = 1 / 1.30^i；ph = rand() * 2π
  按整数频率求和保证可平铺：dhdu/dhdv = Σ amp*k*cos(2π(kx*u + kv*v) + ph)；
  法线 = normalize(-dhdu*0.010, -dhdv*0.010, 1) 编码进 RGB，A=255。
  wrapS/wrapT = RepeatWrapping，repeat.set(4, 4)，LinearMipmapLinearFilter，
  generateMipmaps = true，anisotropy = 最大各向异性
- 滚动：每帧 offset.y += 0.08*dt，offset.x -= 0.08*dt*0.45（dt 为真实帧间隔并 clamp 到 ≤0.05）
- 倒影复用同一张纹理：每帧把 offset 同步给倒影 uniform（uMapOffset.copy(tex.offset)）

======================= 六、山脉剪影 =======================
- 水平地面：const g = new THREE.PlaneGeometry(3600, 900, 420, 190);
  g.rotateX(-Math.PI / 2);   // ★ 是 -90°（-Math.PI/2），不是 -180°
  g.translate(0, 0, -410);   // ★ 平移不可省
  ★ 写成 rotateX(-Math.PI) 会让平面留在 XY 竖直面里，所有顶点 z≡0
    → 高度场里 dist=-z=0 → ramp=0 → 全部高度算成 -10 → 地形塌成一条退化薄片、
      山脊彻底消失（画面会出现一条横贯全屏的亮绿/品红带，那是没被山挡住的帘幕底边）。
  【自检】位移顶点后打印包围盒，必须满足：
    x ≈ [-1800, 1800]，y ≈ [-10.0, +91.5]，z ≈ [-860, +40]
    若 y 恒为 -10 或 z 恒为 0，就是旋转写错了。
- 高度场（JS 端一次性位移顶点）：
  hash2(x,y) = fract(sin(x*127.1 + y*311.7) * 43758.5453123)
  vnoise2(x,y)：同 GLSL 的 vnoise（五次平滑 + 双线性）
  fbm2(x,y,oct=4)：gain 0.5、lacunarity 2.03、按幅度和归一化到 0..1
    ★ fbm2 与 fbm3 不是同一个函数：fbm2 逐阶只做 f *= 2.03，【不加】vec2(11.7,5.3) 偏移；
      只有 GLSL 的 fbm3 才加偏移。给 fbm2 也加偏移，山脊形状会明显不同（实测过）。
    JS 参考实现：
      const fbm2 = (x, y, oct = 4) => {
        let v = 0, amp = 0.5, f = 1, norm = 0;
        for (let i = 0; i < oct; i++) { v += amp*vnoise2(x*f, y*f); norm += amp; f *= 2.03; amp *= 0.5; }
        return v / norm;
      };
  ridged(x,y,oct=4) = 1 - |2*fbm2(x,y,oct) - 1|
  terrainHeight(x, z):
    dist  = -z
    ramp  = smoothstep(150, 430, dist)        // 近处沉入水下
    ramp2 = smoothstep(430, 880, dist)
    r1 = ridged(x*0.00155, z*0.00155, 4)
    r2 = ridged(x*0.00420, z*0.00420, 4)
    fine = fbm2(x*0.014, z*0.014, 4)
    h = (r1*0.78 + r2*0.34) * 64 * ramp + ramp2*30 + fine*3.4*ramp
    h *= 0.52 + 0.48*smoothstep(0, 300, |x|)  // 中间留峡谷走廊
    return h - 10.0
  位移后 computeVertexNormals()
- MeshStandardMaterial：color #0a0e0a、roughness 1.0、metalness 0.0、dithering true（无高光）
- 山脊染色（自发光项，不是灯光！）用 onBeforeCompile 注入：
  vertex：在 #include <common> 后加 varying vec3 vWPos;
          在 #include <begin_vertex> 后加 vWPos = (modelMatrix*vec4(position,1.0)).xyz;
  fragment：在 #include <common> 后加 varying vec3 vWPos; uniform vec3 uColA,uColB; uniform float uTint;
            在 #include <emissivemap_fragment> 后加：
      float hn = clamp((vWPos.y - 4.0) / 58.0, 0.0, 1.0);
      vec3 tint = mix(uColA, uColB, clamp(0.02 + 0.30*hn + 0.12*sin(vWPos.x*0.011), 0.0, 1.0));
      totalEmissiveRadiance += tint * pow(hn, 2.4) * uTint;
  uTint 默认 0.09

======================= 七、星空 =======================
- Points，count 800；【固定种子 LCG，seed = 20240930】，不要用 Math.random()
  （固定种子 → 每次加载星图都一样，不会刷新一次换一片星空）：
    let s = 20240930 >>> 0;
    const srand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  位置：u = srand()，v = srand()*0.94 + 0.02，theta = u*2π，phi = acos(1 - v)，
        r = 520 + srand()*300，
        pos = (r*sin(phi)*cos(theta), r*cos(phi) + 8, r*sin(phi)*sin(theta))
        aSeed = srand()，aSize = 0.35 + srand()*0.75
- 顶点：gl_PointSize = clamp(uSize * uGain * uPix * aSize / dist, 1.0, 3.4)
  uSize = 0.05（世界尺寸），uGain = 26.0，
  uPix = (drawingBufferHeight * 0.5) / tan(fov/2)，resize 时更新
  ★ 0.05 世界单位在 600 距离上只有 0.09 像素，必须靠 uGain/uPix 换算成像素尺寸再 clamp，
    否则星星完全看不见。
  闪烁：tw = 0.70 + 0.30*sin(uTime*(0.5 + aSeed*1.7) + aSeed*41.0)；vA = tw*(0.55 + 0.45*aSeed)
- 片元：r2 = dot(gl_PointCoord*2-1, gl_PointCoord*2-1)；r2>1 丢弃；
  gl_FragColor = vec4(uColor, pow(1.0 - r2, 2.4) * uOpacity * vA)
  uColor 白、uOpacity = 0.6；AdditiveBlending、transparent、depthWrite:false、renderOrder -90

======================= 八、天穹 =======================
- SphereGeometry(1800, 48, 24)，BackSide，depthWrite:false，frustumCulled:false，renderOrder -100
- 天空渐变：col = mix(uHorizon, uTop, smoothstep(-0.06, 0.60, d.y))
  uTop = #000104，uHorizon = #04090e
- 地平线漫射辉光（极光作为唯一光源的"环境"项，必须窄）：
  band = exp(-pow((h - 0.010) / 0.028, 2.0))
  n = fbm3(vec2(atan(d.z, d.x) * 1.7 + uTime * 0.012, h * 6.0 - uTime * 0.02))
  g = mix(uColA, uColB, smoothstep(0.30, 0.85, n))
  col += g * band * uGlow * (0.45 + 0.85 * n)
  col += g * exp(-pow((h - 0.055) / 0.150, 2.0)) * uGlow * 0.10 * n
  输出前过 hueShift(col, uHue)
  uGlow 基准 0.16，每帧呼吸：uGlow = 0.16 + 0.025*sin(elapsed*0.35)

======================= 九、光照（★ 这一节最容易做错） =======================
- HemisphereLight(0x0d3a2b, 0x01030a, 0.30)
- DirectionalLight 强度必须是 0.0，颜色 = 绿#39ff8a 向 品红#ff2d6f 插值 0.22，位置 (-140, 55, -220)
  ★★ 低粗糙度(0.15)水面 + 任何可观的平行光 ⇒ GGX 镜面峰值 ≈ 1/(π·α²) ≈ 14 倍，
     会在画面里形成一条贯穿地平线的"探照灯"白色光柱，与参考质感完全不符。
     本作品"全程自发光主导"：水面与山脊靠【倒影层 + 山脊自发光染色 + Bloom】间接照亮。

======================= 十、后期 =======================
EffectComposer(renderer) → RenderPass(scene, camera)
  → UnrealBloomPass(new Vector2(w, h), strength=0.8, radius=0.4, threshold=0.6)
  → OutputPass()          // ACES + sRGB 转换在这里发生
★ composer.setSize(w, h) 内部会按 pixelRatio 同步所有 pass 尺寸；
  不要再单独调 bloomPass.setSize(w, h)，否则会把辉光缓冲改成半分辨率。

======================= 十一、相机运镜（8s 缓入缓出） =======================
  const CAM = { x: 0, y: 1.35, z: 14 };
  ph    = (elapsed / 8.0) * 2π
  dolly = 0.5 - 0.5*cos(ph)          // 0→1→0，ease-in-out
  pan   = sin(ph)                    // -1→1→-1
  camera.position = (CAM.x + pan*1.9, CAM.y + 0.10*dolly, CAM.z + 3.4*dolly)
  camera.lookAt(pan*0.7, 3.1 + 0.35*dolly, -40)
（以上位移再乘一个统一幅度 m = params.camMotion，默认 1.0）
★ 相机高度必须是 y≈1.35（贴近水面）。相机越高，倒影落点越远：
  在 y=2.8 时最亮绿带的倒影正好落在距相机约 30 单位处，等于 fade 距离 → 倒影几乎全灭。

======================= 十二、HUD（底部控制条 + lil-gui） =======================
底部一条半透明控制条（高 92px，顶部 1px 绿→品红发丝线，背景自下而上渐变 + backdrop-blur(2px)）：
- 左：三行等宽小字（11px，letter-spacing .09em，色 rgba(186,226,206,.62)），
      第一行 `CAM  X +0.00  Y +1.35  Z +14.00`（坐标带正负号、两位小数），
      第二行 `FPS 60.0  ·  1920×1080  ·  RUNNING`，
      第三行 `H 面板 · R 恢复默认 · SPACE 暂停`（9.5px，透明度 .45，字距 .16em），
      约 8Hz 刷新（hudTimer > 0.12s）
      ★ 第二行那个分辨率显示的是【drawing buffer 尺寸】(drawingBufferWidth×Height)，
        不是窗口尺寸 —— 1080p 窗口下会显示成 1898×926 之类，这是对的，别"修"成窗口尺寸。
- 中：斜体占位文本 `aurora curtain — a realtime study in light · 极光帷幕`（13px，字距 .16em，透明度 .46）
- 右：控件组（pointer-events:auto，其余 HUD pointer-events:none）：
  · 「恢复默认」小箭头：24×24 圆形按钮，边框 rgba(57,255,138,.20)，
    内嵌 14×14 SVG（stroke-width 2.1，两段路径：一段 8.4 半径圆弧 + 一个左上角箭头），
    点击/按 R 触发重置，并给 svg 加 0.5s 旋转 -360° 动画作反馈
  · 彩虹色谱条：轨道 148×9px，圆角 5px，渐变
    linear-gradient(90deg,#ff2d2d,#ff9a2d,#ffe62d,#39ff8a,#2de1ff,#2d6bff,#c02dff,#ff2d6f,#ff2d2d)；
    上面叠一个透明 range 输入（拖动）与一个 2×17px 的发光游标（#f2fff8，绿色 box-shadow）
  · 数值框：56px 宽，等宽 11px，绿色 #39ff8a，与色谱条双向联动
  · 三者共同控制 uHue（0..1，绕灰度轴旋转色相；默认 0.00）
- lil-gui 面板：挂在 #guiHost 容器里（position:fixed，right 20px，bottom 92+16px），
  CSS 变量主题：背景 rgba(6,14,12,.50)、widget rgba(255,255,255,.10)、hover 绿 .20、
  focus 绿 .30、数字 #39ff8a、字符串 #ff2d6f、文字 #cfe9dc、标题栏 rgba(8,22,18,.66)、
  字号 11px、宽 236px、边框 rgba(57,255,138,.14)、圆角 7px、opacity .92、backdrop-filter blur(9px)
  面板内容：
  · 4 个常驻滑块：极光流速 0.05–0.40 步 .005（默认 0.22）、极光亮度 0.3–3.0 步 .01（默认 0.50）、
    辉光强度 0–2.5 步 .01（默认 0.8）、曝光 0.2–2.5 步 .01（默认 1.0）
  · 文件夹「水面 WATER · 倒影 REFLECTION」（默认折叠）：波纹流速 0–0.30 步 .005（0.08）、
    倒影强度 0–2.0 步 .01（0.75）、倒影衰减 5–120 步 1（30）、波纹扰动 0–0.15 步 .002（0.07）、
    倒影混合 ['Screen','Additive']（Screen）
  · 文件夹「进阶 ADVANCED」（默认折叠）：山脊染色 0–0.6 步 .01（0.09）、
    辉光半径 0–1.5 步 .01（0.4）、辉光阈值 0–1.5 步 .01（0.6）、运镜幅度 0–2.0 步 .01（1.0）
- 快捷键：H 显隐 HUD、R 恢复默认、空格 暂停
- 页面必须挂 window.onerror → 把错误文本显示在居中的加载层上（着色器编译失败时能立刻看见）

======================= 十三、恢复默认的实现（别漏） =======================
启动时冻结一份默认值快照 const DEFAULTS = Object.freeze({ ...params })，
点小箭头 / 按 R 时执行：
  Object.assign(params, DEFAULTS);
  然后把这些【同步到真正生效的地方】，只改 params 是没用的：
  G.uSpeed.value / G.uIntensity.value、renderer.toneMappingExposure、
  bloomPass.strength/radius/threshold、山脊 uTint、每个倒影材质的
  uAlpha(=层alpha×reflStrength)/uFadeDist/uRipple 与混合模式、
  applyHue(params.hue)（同时更新游标位置、range 与数值框）、
  gui.controllersRecursive().forEach(c => c.updateDisplay())（把面板显示拉回默认）、
  document.body.classList.toggle('hud-hidden', !params.showHUD)

======================= 十四、绝对不要做的事（会直接毁掉画面） =======================
1. 不要给水面/山脊加任何可观的平行光或点光（见第九节，会出探照灯光柱）。
2. 不要去掉 alpha 的 min(…, 1.0)：加性叠加 + ACES 高光去饱和会让整条帘幕糊成白色。
3. 不要把极光平面放得比山脉近：山脊挡不住帘幕底边时，地平线会出现一条硬切直线。
4. 倒影层不要开 depthTest：镜像几何整体在水面下方，必须盖在水面之上渲染。
5. 倒影的距离衰减不要用顶点插值或"到镜像点的距离"：必须逐片元求视线与 y=0 的交点，
   否则要么整片倒影消失，要么整片水面发亮。
6. 倒影混合不要用普通 additive（会灰白发闷）：用预乘颜色 + Screen 自定义混合。
7. 不要把 fbm 换成 simplex、不要把 folds 频率 8.0 调回 3 左右：
   那样一屏只剩一条巨大帘幕，完全没有多条极光带的结构。

======================= 十五、时间相位开关 ?t=（截图 / 取帧用） =======================
动画相位由实时时钟推进。要让 `?t=` 截出来的图稳定（而不是每次快门差那么一点），
把下面三处跟着真实时钟走的量一并固定：
1) 时间相位：URL 带 ?t=<秒> 时把 elapsed 钉死并暂停
   const QUERY = new URLSearchParams(location.search);
   const PINNED_T = QUERY.has('t') ? Math.max(0, parseFloat(QUERY.get('t')) || 0) : null;
   if (PINNED_T !== null) params.paused = true;
   主循环： elapsed = (PINNED_T !== null) ? PINNED_T : (params.paused ? elapsed : elapsed + dt)
   相机相位由 elapsed 推导，自动一起停住。
2) 水面波纹偏移：钉死时取【解析值】而不是逐帧累加（累加依赖真实 dt，会跑偏）
   if (PINNED_T !== null) tex.offset.set(-PINNED_T*waveSpeed*0.45, PINNED_T*waveSpeed);
   else if (!params.paused) { offset.y += waveSpeed*dt; offset.x -= waveSpeed*dt*0.45; }
3) HUD 里的实时 FPS：钉死时不要输出 fpsSmooth（它是真实帧率，每次都不一样），
   改输出固定串：`FPS --` 与 `PINNED t=<秒>`，免得 HUD 上的数字让每次截图都不同。
★ 顺带：把调试对象暴露到 window.AURORA（scene/camera/renderer/composer/bloomPass/
  params/DEFAULTS/G/SPEC/reset 以及各材质与图层），便于自检与写脚本截图。

======================= 十六、验收（做完请自查） =======================
0. 【先做这一步】打印三处世界尺度，90% 的"看着不对"都出在这里：
   - 地形包围盒：x ≈ [-1800,1800]、y ≈ [-10.0,+91.5]、z ≈ [-860,+40]（塌成 y=-10 就是旋转写错）
   - 水面：y 恒为 0，覆盖 z ∈ [-700, +300]
   - 极光两层在 z = -820 / -1250（必须比地形的 -860 更远）
1. 1920×1080：天空接近纯黑，能数出稀疏白点星；山脊是近黑剪影、只有顶部有极淡的绿/品红染色；
   山脊线出现在地平线上方约 3–6% 画面高度处，起伏明显、不是一条平直横线。
2. 极光：多条竖直帘幕，底缘荧光绿 #39ff8a 亮边 → 向上过渡到品红 #ff2d6f 并拖尾变淡；
   帘幕之间有暗隙；整体不过曝（峰值绿通道线性值约 0.6–0.8，不该出现成片死白）。
3. 水面：深近黑，其上有"破碎的"极光镜像 —— 被横向条纹切断、随距离向地平线淡出；无光斑光柱。
4. 后期：只有最亮的帘幕芯与地平线辉光溢出发光，辉光不该糊满全屏。
5. 运镜 8 秒一个来回，能明显看出 dolly + pan 且两端缓入缓出。
6. HUD/面板/快捷键/恢复默认箭头都在，且点箭头能把被改乱的参数一键拉回默认。
7. 单个 HTML，断网 file:// 双击可运行。
```

---

## B 段 · 生图提示词（参考图）

生成模型本身是随机的，**只能作质感与构图参考**；需要确定的某一刻画面时，
直接截本作品的渲染静帧（见 E 段的 `?t=` 开关）。

**正向**

```text
procedural aurora borealis curtain over a mirror-still lake, multiple vertical plasma ribbons
rising behind a near-black mountain silhouette, bright fluorescent green (#39FF8A) lower border
fading upward into magenta-red (#FF2D6F) tips, dark navy-black starry sky, sparse dim stars,
broken rippled mirror reflection of the aurora on the water surface, horizontal ripple banding
tearing the reflection apart, emissive-only lighting, no key light, subtle bloom glow around the
brightest ribbons, ACES filmic tone mapping, deep blacks and high contrast, realtime WebGL
three.js render look, 16:9 cinematic wide shot, isolated scene
```

**负向**

```text
text, watermark, signature, UI, HUD, people, buildings, trees, birds, moon, sun, clouds, lens flare,
motion blur, heavy noise, oversaturated white blowout, specular light column, searchlight,
god rays from a point light, cartoon, painting, lowres, jpeg artifacts
```

参数建议：`--ar 16:9`、风格强度偏高、`--style raw`；不要加 "photo/realistic"
（会带出相机噪点与镜头光晕，破坏"自发光主导"的干净感）。想更贴近就给成品截图做参考图，
权重中高，而不是纯文字生成。

---

## C 段 · 成品真实数值速查表（逐条对应源码行号）

> 全部读自当前源码，可直接回查。改任何一项都会改变画面，请按值照抄。

### 场景常量与默认参数

| 参数 | 当前值 | 源码位置 |
|---|---|---|
| 极光绿 / 品红 | `#39ff8a` / `#ff2d6f` | app.js:18, 55–56 |
| 极光流速 `auroraSpeed` | **0.22**（范围 0.05–0.40） | app.js:28 |
| 极光亮度 `auroraIntensity` | **0.50** | app.js:29 |
| 色相 `hue` | **0.00** | app.js:30 |
| 波纹流速 `waveSpeed` | **0.08** | app.js:31 |
| 倒影强度 `reflStrength` | **0.75** | app.js:32 |
| 倒影衰减 `reflFade` | **30** | app.js:33 |
| 波纹扰动 `reflRipple` | **0.07** | app.js:34 |
| 倒影混合 `reflBlend` | **Screen** | app.js:35 |
| 山脊染色 `ridgeGlow` | **0.09** | app.js:36 |
| 曝光 `exposure` | **1.0** | app.js:37 |
| 辉光 强度/半径/阈值 | **0.8 / 0.4 / 0.6** | app.js:38–40 |
| 运镜幅度 `camMotion` | **1.0** | app.js:41 |
| 水面 base / roughness / metalness / tile | **#05080a / 0.15 / 0.0 / 4** | app.js:19, 501–507 |
| 星空 count / size / opacity | **800 / 0.05 / 0.6** | app.js:22 |
| 星空像素增益 `uGain` | **26.0**，点尺寸 clamp **1.0–3.4 px** | app.js:385, 267 |
| 星空随机种子 | **20240930**（LCG：×1664525 + 1013904223 mod 2³²） | app.js:355–356 |
| 山脉色 / 粗糙度 | **#0a0e0a / 1.0**（metalness 0） | app.js:21, 420–424 |
| 天穹 uTop / uHorizon / uGlow | **#000104 / #04090e / 0.16**（呼吸 ±0.025, ω=0.35） | app.js:338–342, 795 |
| 相机 位置 / fov / near / far | **(0, 1.35, 14) / 55 / 0.5 / 6000** | app.js:327–328 |
| 运镜周期 | **8.0 s**，pan ×1.9、y +0.10、z +3.4；lookAt(pan×0.7, 3.1+0.35d, −40) | app.js:24, 746–757 |
| 雾 | FogExp2(0x02060a, **0.00115**)，只作用于 Standard 材质 | app.js:324 |
| 半球环境光 | HemisphereLight(0x0d3a2b, 0x01030a, **0.30**) | app.js:517 |
| 平行主光 | **强度 0.0**（颜色=绿→品红 lerp 0.22，位置 −140,55,−220） | app.js:519–521 |

### 极光两层

| 层 | w×h | position | seed | uAlpha | band / bandW | top | lowY / lowFade |
|---|---|---|---|---|---|---|---|
| 1（主体） | 2400 × 620 | (0, 240, −820) | 0.00 | 1.00 | 80 / 72 | 560 | 8 / 34 |
| 2（远景） | 3200 × 900 | (0, 340, −1250) | 3.70 | 0.24 | 110 / 92 | 640 | 8 / 60 |

（app.js:525–528；两层 renderOrder 10，倒影副本 30）

### 帘幕 / 羽化 / 配色的真实常量

| 项 | 值 | 源码 |
|---|---|---|
| 时间驱动 | `t = uTime * uSpeed * 8.0` | app.js:166 |
| 域扭曲 | w1×0.62 + w2×0.26；w1 系数 (2.1, 17.0, 0.085)/(0.40, −0.045)，w2 (4.7, −9.0, −0.055)/(0.72, 0.035) | app.js:144–146 |
| 褶皱频率 | folds **8.0**/0.20、detail **16.0**/0.42、striae **26.0**/0.25、rays **34.0**/0.10 | app.js:149–152 |
| body 合成 | folds×0.86 + detail×0.30 → smoothstep(**0.40, 0.90**) → ×mix(0.55,1.30,striae) ×mix(0.78,1.22,rays) | app.js:154–156 |
| 暗隙 | gap=smoothstep(0.30,0.64, fbm(p.x×4.5+seed×3+t×0.06, p.y×0.18))，×mix(**0.32**,1.0,gap) ×clamp(detail×3.4,0,1.3) | app.js:158–159 |
| 返回值 | `pow(body, 1.15)`（alpha 用的就是它） | app.js:162 |
| 垂直羽化 | low=smoothstep(lowY, lowY+lowFade, yA)；edge=smoothstep(band−**24**, band+**2**)；tail=exp(−max(0,yA−band)/bandW)；haze=exp(−\|yA−band\|/(bandW×1.9))；vmask=low×(edge×tail + haze×**0.03**) | app.js:191–195 |
| 边缘羽化 | xf=smoothstep(0,0.12,uv.x)×(1−smoothstep(0.88,1,uv.x))；hf=smoothstep(0,0.05,vUv.y)×(1−smoothstep(0.95,1,vUv.y)) | app.js:198–199 |
| alpha | `min(body×vmask×xf×hf, 1.0)` | app.js:201 |
| 配色 | cm=clamp(noiseMix×**0.40** + smoothstep(band, top×**0.46**, yA)×**0.95**, 0, 1)；col=mix(绿,品红,cm)；亮核 += 绿×edge×exp(−max(0,yA−band)/(bandW×0.5))×(0.30+0.70×noiseMix)×**0.22**；再 ×uIntensity | app.js:204–207 |

### 倒影的真实常量

| 项 | 值 | 源码 |
|---|---|---|
| 丢弃阈值 | `vWorld.y > -0.02` 丢弃 | app.js:172 |
| 波纹 UV | `ruv = vWorld.xz × uMapScale + uMapOffset`，uMapScale = **4/1000 = 0.004** | app.js:173, 545 |
| UV 扰动 | `uv += nrm.xy × uRipple`（uRipple **0.07**） | app.js:175 |
| 破碎横移 | `uv.x += (hash21(vec2(floor(z×0.32), floor(t×0.6))) − 0.5) × **0.022**` | app.js:178 |
| 高度还原 | `yA = -vWorld.y` | app.js:185 |
| 距离衰减 | d=交点水平距；fadeD=1−clamp(d/**30**,0,1)；mirror=mix(**0.07**,1,fadeD)×smoothstep(**1.5, 9.0**,d) | app.js:212–216 |
| 条带破碎 | `mirror *= mix(0.08, 1.0, smoothstep(−0.50, 0.35, sh))` | app.js:217 |
| 输出 | `col × alpha × mirror × uAlpha × **0.68**`，alpha=1（预乘） | app.js:219 |
| uAlpha | 层 alpha × **0.75** | app.js:535 |
| 混合 | Screen：`OneMinusDstColorFactor / OneFactor`（Additive：`One / One`） | app.js:597–609 |
| 镜像组 | `mirrorGroup.scale.set(1,-1,1)`，副本 position 与主体一致 | app.js:554–556 |

### HUD / 后期

| 项 | 值 | 源码 |
|---|---|---|
| 底条高度 | **92px**；发丝线 1px，绿→品红渐变 | shell.html:11, 33–36 |
| 左三行 | 11px 等宽（.09em）、第二行 opacity .78、第三行 9.5px opacity .45；8Hz 刷新 | shell.html:38–47, app.js:801–810 |
| 中斜体 | 13px、字距 .16em、色 rgba(206,238,224,.46) | shell.html:49–54 |
| 色相条 | 轨道 **148×9px**、9 段渐变、游标 2×17px、数值框 56px | shell.html:66–93 |
| 恢复箭头 | 24×24 圆钮、SVG 14×14、stroke-width 2.1、点击后 0.5s 旋转 −360° | shell.html:95–110, app.js:705–709 |
| lil-gui | 宽 236px、字号 11px、背景 rgba(6,14,12,.50)、数字 #39ff8a、opacity .92、blur(9px) | shell.html:113–132 |
| 辉光 | UnrealBloomPass(vec2(w,h), **0.8, 0.4, 0.6**) + OutputPass（ACES + sRGB） | app.js:616–621 |
| 键位 | H 面板 / **R 恢复默认** / 空格 暂停 | app.js:712–722 |
| 默认值快照 | `DEFAULTS = Object.freeze({...params})`（启动时冻结） | app.js:47 |

---

## D 段 · 7 个翻车点（症状 → 病因）

| 症状 | 病因 |
|---|---|
| 画面里一条竖直白光柱（多在画面中/左下） | 水面被加了平行光或点光 → 把方向光强度设为 0 |
| 极光大面积死白、彩色被冲淡 | alpha 没 clamp 到 1，或 emission（uIntensity）> 0.8 |
| 地平线处极光被切出一条直线 | 极光平面比山脉近，或垂直羽化用了 uv 而不是世界高度 yA |
| 水面全黑，完全看不到倒影 | fade 的 dist 用了"到镜像点距离"，或相机太高（y ≫ 1.5） |
| 倒影糊成一片发灰的白 | 用了普通 AdditiveBlending 而不是预乘 + Screen 自定义混合 |
| 整个下半天空发绿发白 | 天穹地平线辉光过宽/过强（σ 0.028、uGlow 0.16 不要放大） |
| 星星几乎看不见 / 大得发糊 | 直接用了世界尺寸 0.05 没做像素换算，或没 clamp 1–3.4px |

---

## E 段 · 自检清单与截图开关

**自检（先做这一步）**：打印三处世界尺度，90% 的"看着不对"都出在这里 ——
- 地形包围盒：x ≈ [-1800,1800]、y ≈ [-10.0,+91.5]、z ≈ [-860,+40]（塌成 y=-10 就是旋转写错）
- 水面：y 恒为 0，覆盖 z ∈ [-700, +300]
- 极光两层在 z = -820 / -1250（必须比地形的 -860 更远）

（逐项验收见 A 段第十六节。）

**截图开关 `?t=<秒>`**：打开 `aurora-curtain.html?t=5.2` 会把时间相位停在第 5.2 秒并暂停，
相机与极光都停在那一姿态，HUD 第二行显示 `PINNED t=5.2`、FPS 显示 `--`。
想抓色相演化中某一刻的静帧（例如绿期 0.6 s、爆发期 1.4 s）用这个参数即可，
不必等动画自己走到；不同的 `?t=` 值画面不同，属正常。

**两条必须写死的写法**（把 A 段单独交给别的模型实现时实测踩过）：

| 容易写成 | 正确写法 | 后果 |
|---|---|---|
| `rotateX(-Math.PI)` 且漏 `translate(0,0,-410)` | `rotateX(-Math.PI/2)` + `translate(0,0,-410)` | 顶点 z 恒为 0 → ramp=0 → 高度全 -10 → **山脊消失**，出现横贯全屏的亮带 |
| 给地形 `fbm2` 也加了 `+(11.7,5.3)` 逐阶偏移（照抄 GLSL 的 `fbm3`） | `fbm2` **不加**偏移，只有 `fbm3` 加 | 山脊形状改变（变成一个大圆包） |

这两处写错都会让山脊消失或变形；此外再对照 D 段的 7 个翻车点逐条排查。

// WebGL2 shader engine for the visual view. Owns the shader sources, the
// GL resources and the VIZGL state; the render loop and its UI still live
// in app.js and drive this through VIZGL.

import { clamp } from '../core/util.js';

// ─── WebGL2 shader engine ────────────────────────────────────────────────────
// Raymarched kaleidoscopic neon tunnel with HDR feedback trails, plus polar
// spectrum/waveform rings sampled from an audio texture. A post pass adds
// bloom, beat-driven chromatic aberration, tone mapping, vignette and grain.
// The 2D particle renderer above stays as the fallback when WebGL2 (or shader
// compilation) is unavailable.

const VIZ_VERT_SRC = `#version 300 es
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

const VIZ_SIM_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 frag;
uniform sampler2D uPrev;
uniform sampler2D uAudio; // 512x2 R8: row 0 = spectrum, row 1 = waveform
uniform vec2 uRes;
uniform float uTime;
uniform float uBass;
uniform float uMid;
uniform float uHigh;
uniform float uLevel;
uniform float uBeat;
uniform float uHue;
uniform vec2 uCam;
uniform vec4 uA; // x speed, y fold, z twist, w feedback decay
uniform vec4 uB; // x glow, y spectrum-ring mix, z warp zoom, w waveform mix
uniform float uStars;  // starfield intensity (mood × slow LFO)
uniform float uStarT;  // integrated star fly-through phase
uniform vec4 uShock;   // kick shockwave: x age (s), y amplitude, z light gate, w per-kick shape seed
uniform float uGlint;  // hat/perc star-glint boost
uniform vec3 uNote;    // osc note flare: x pitch-class angle 0..1, y age, z amp

mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
vec3 pal(float t) { return 0.5 + 0.5 * cos(6.28318 * (t + vec3(0.0, 0.33, 0.67))); }
float hash21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

// Parallax star dust: four depth layers cycling toward the camera. Each layer
// is a sparse hash grid; ph drives scale (far→near) and fades at both ends so
// layers recycle invisibly. Highs push twinkle and brightness.
vec3 stars(vec2 uv) {
  vec3 col = vec3(0.0);
  for (int l = 0; l < 4; l++) {
    float ph = fract(uStarT + float(l) * 0.25);
    float scale = mix(9.0, 0.9, ph);
    float fade = ph * (1.0 - ph) * 4.0;
    vec2 guv = (uv + uCam * (0.05 + ph * 0.25)) * scale + float(l) * 7.31;
    vec2 cell = floor(guv);
    vec2 f = fract(guv) - 0.5;
    float h = hash21(cell);
    if (h < 0.82) continue;
    vec2 off = vec2(hash21(cell + 1.3), hash21(cell + 2.7)) - 0.5;
    float d = length(f - off * 0.8);
    float tw = 0.55 + 0.45 * sin(uTime * (4.0 + h * 14.0) + h * 40.0);
    // Radius scales with the layer so screen size stays pin-point; hard inner
    // edge keeps them crisp instead of glow blobs.
    float r = (0.0028 + ph * 0.0022) * scale;
    float star = smoothstep(r, r * 0.25, d);
    vec3 scol = mix(vec3(1.0), pal(uHue + 0.5 + h * 0.3), 0.4);
    col += scol * star * fade * tw * (0.6 + uHigh * 1.3 + uGlint * 1.6);
  }
  return col * uStars;
}

vec3 tunnel(vec2 uv) {
  vec3 ro = vec3(uCam * 0.5, uTime * uA.x);
  vec3 rd = normalize(vec3(uv - uCam * 0.18, 1.0));
  rd.xy *= rot(uTime * 0.06 + uBass * 0.25);
  vec3 acc = vec3(0.0);
  float t = 0.15;
  for (int i = 0; i < 54; i++) {
    vec3 p = ro + rd * t;
    vec2 q = p.xy;
    q *= rot(p.z * uA.z);
    float wob = 0.55 + 0.12 * sin(p.z * 0.31 + uTime * 0.4);
    for (int f = 0; f < 4; f++) {
      q = abs(q) - uA.y * wob;
      q *= rot(uTime * 0.11 + float(f) * 0.77 + uMid * 0.3);
    }
    float d1 = abs(length(q) - 0.14 - 0.10 * uBass) + 0.004;
    vec2 b = abs(q) - vec2(0.04 + uMid * 0.30, 0.015);
    float d2 = length(max(b, 0.0)) + 0.004;
    float ht = uHue + p.z * 0.015 + float(i) * 0.003;
    acc += pal(ht) * (uB.x * 0.0009) / (0.004 + d1 * d1 * 34.0);
    acc += pal(ht + 0.45) * (uB.x * 0.0006) / (0.004 + d2 * d2 * 52.0);
    t += 0.11 + t * 0.028;
  }
  return acc;
}

vec3 rings(vec2 uv) {
  float r = length(uv);
  float a = atan(uv.y, uv.x);
  float f = abs(fract(a / 6.28318 + 0.5) * 2.0 - 1.0); // mirrored for symmetry
  float s = texture(uAudio, vec2(f, 0.25)).r;
  float w = texture(uAudio, vec2(f, 0.75)).r - 0.5;
  vec3 col = vec3(0.0);
  float rs = 0.30 + s * 0.24 + uBass * 0.06;
  float ds = abs(r - rs);
  col += pal(uHue + 0.12 + s * 0.25) * (s * s) * uB.y * 0.0019 / (0.0012 + ds * ds * 9.0);
  float rw = 0.58 + w * 0.42;
  float dw = abs(r - rw);
  col += pal(uHue + 0.62) * (0.25 + uLevel) * uB.w * 0.0011 / (0.0012 + dw * dw * 16.0);
  return col;
}

void main() {
  vec2 uv = (vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
  vec3 col = stars(uv) + tunnel(uv) + rings(uv);

  // Kick shockwave: ring expanding from centre at the scheduled hit time.
  float shockR = uShock.x * 1.5;
  float shockBand = exp(-abs(length(uv) - shockR) * 22.0);
  float shockAmp = uShock.y * exp(-uShock.x * 3.0);
  col += pal(uHue + 0.05) * shockBand * shockAmp * 0.9 * uShock.z;

  // Osc note flare: arc at the note's pitch-class angle, drifting outward.
  if (uNote.z > 0.001) {
    float na = uNote.x * 6.28318 - 3.14159;
    float a = atan(uv.y, uv.x);
    float ad = abs(mod(a - na + 3.14159, 6.28318) - 3.14159);
    float flare = exp(-ad * 5.0) * exp(-abs(length(uv) - (0.42 + uNote.y * 0.25)) * 14.0);
    col += pal(uHue + 0.25 + uNote.x * 0.4) * flare * uNote.z * exp(-uNote.y * 3.5) * 1.2;
  }

  // Feedback: sample last frame slightly zoomed + rotated so trails rush
  // outward with the tunnel; tiny channel rotation drifts trail hues. The
  // shockwave also refracts the trail buffer so kicks ripple through history.
  vec2 fuv = vUv - 0.5;
  fuv *= 1.0 - (0.004 + uBeat * 0.018 + uB.z * 0.003 + uBass * 0.004);
  fuv *= rot(0.0035 * sin(uTime * 0.12) + (uMid - 0.25) * 0.005);
  fuv += normalize(fuv + 1e-4) * shockBand * shockAmp * 0.012;
  vec3 prev = texture(uPrev, fuv + 0.5).rgb;
  prev = mix(prev, prev.gbr, 0.012 + uBeat * 0.05);
  col += prev * uA.w;
  frag = vec4(min(col, vec3(60.0)), 1.0);
}
`;

// MINIMAL style: dark, square, geometric. Same uniform names as the psychair
// sim but repurposed — uA: x speed, y grid scale, z rotate rate, w phosphor
// decay; uB: x grid-line mix, y spectrum-bars mix, z cell flicker, w waveform
// mix. Feedback uses max() (phosphor persistence) so nothing blooms white.
const VIZ_MIN_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 frag;
uniform sampler2D uPrev;
uniform sampler2D uAudio;
uniform vec2 uRes;
uniform float uTime;
uniform float uBass;
uniform float uMid;
uniform float uHigh;
uniform float uLevel;
uniform float uBeat;
uniform float uHue;
uniform vec2 uCam;
uniform vec4 uA;
uniform vec4 uB;
uniform float uStars; // repurposed: glyph density
uniform vec4 uShock;
uniform float uGlint;
uniform vec3 uNote;

mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
float hash21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main() {
  float asp = uRes.x / uRes.y;
  vec2 uv = (vUv - 0.5) * vec2(asp, 1.0);
  uv *= rot(uTime * uA.z);
  uv += uCam * 0.02;
  float t = uTime * uA.x;
  vec3 accent = mix(vec3(1.0), 0.5 + 0.5 * cos(6.28318 * (uHue + vec3(0.0, 0.33, 0.67))), 0.45);
  vec3 col = vec3(0.0);

  // Grid: barely-there lines, breathing with level.
  vec2 g = uv * uA.y;
  vec2 cell = floor(g);
  vec2 f = fract(g);
  vec2 e = min(f, 1.0 - f);
  float line = smoothstep(0.035, 0.0, min(e.x, e.y));
  col += accent * line * uB.x * (0.035 + uLevel * 0.10);

  // Sparse cell strobes on a quantized clock; half filled, half dimmer.
  // A slow spatial wave gates them so activity travels across the frame
  // instead of twinkling uniformly forever.
  float clk = floor(t * (1.5 + uB.z * 5.0));
  float hc = hash21(cell + clk * 13.71);
  float on = step(0.982 - uB.z * 0.01, hc);
  float inset = step(0.14, f.x) * step(f.x, 0.86) * step(0.14, f.y) * step(f.y, 0.86);
  float fill = step(0.5, hash21(cell + clk * 7.3));
  float waveGate = 0.55 + 0.45 * sin(cell.x * 0.9 + cell.y * 1.3 + uTime * 0.7);
  col += accent * on * inset * mix(0.12, 0.4, fill) * (0.4 + uMid * 0.9) * waveGate;

  // Glyph layer: sparse plus / bracket marks that re-roll on a slow clock.
  float gclk = floor(uTime * 0.21);
  float gh = hash21(cell * 3.1 + gclk * 5.77);
  if (gh > 1.0 - 0.06 * uStars) {
    float gt = hash21(cell * 5.9 + gclk * 3.3);
    vec2 gp = f - 0.5;
    float glyph;
    if (gt < 0.5) {
      glyph = max(step(abs(gp.x), 0.02) * step(abs(gp.y), 0.16),
                  step(abs(gp.y), 0.02) * step(abs(gp.x), 0.16));
    } else {
      glyph = max(step(abs(gp.x + 0.14), 0.02) * step(abs(gp.y), 0.16),
                  step(abs(gp.y + 0.14), 0.02) * step(abs(gp.x), 0.16));
    }
    col += accent * glyph * (0.25 + uHigh * 0.5);
  }

  // Rare row flash: one grid row blinks for a moment every ~13 s.
  float rclk = floor(uTime / 13.0);
  float rphase = fract(uTime / 13.0);
  float rrow = floor((hash21(vec2(rclk, 7.7)) - 0.5) * uA.y * 0.9);
  if (rphase < 0.06 && abs(cell.y - rrow) < 0.5) col += accent * 0.35;

  // Hat ticks: corner dots flashing on a fast clock.
  float th = hash21(cell * 1.7 + floor(uTime * 24.0));
  float corner = step(e.x, 0.07) * step(e.y, 0.07);
  col += accent * corner * step(0.96, th) * uGlint * 0.9;

  // Nested frames: five concentric squares, one per band (bass innermost).
  // Each breathes with its band's energy — spectrum data without EQ-bar
  // literalism.
  if (uB.y > 0.01) {
    for (int i = 0; i < 5; i++) {
      float fi = float(i);
      float be = texture(uAudio, vec2(0.08 + fi * 0.2, 0.25)).r;
      float rr = 0.12 + fi * 0.09 + be * 0.02;
      float d = abs(max(abs(uv.x), abs(uv.y)) - rr);
      col += accent * smoothstep(0.006, 0.002, d) * be * be * 0.55 * uB.y;
    }
  }

  // Perimeter dashes: segments of a square ring flickering like a data bus.
  if (uB.w > 0.01) {
    float chebP = max(abs(uv.x), abs(uv.y));
    float ringD = abs(chebP - 0.40);
    float ang = atan(uv.y, uv.x) / 6.28318 + 0.5;
    float seg = floor(ang * 32.0);
    float segOn = step(0.55, hash21(vec2(seg, floor(uTime * 2.0))));
    float dash = smoothstep(0.006, 0.002, ringD) * step(fract(ang * 32.0), 0.7);
    col += accent * dash * segOn * (0.15 + uLevel * 0.5) * uB.w;
  }

  // Kick: expanding outline, shape drawn per hit from the seed — square,
  // diamond, or corner brackets — so a 4/4 doesn't stamp the same figure.
  vec2 su = uShock.w > 0.35 && uShock.w < 0.7 ? rot(0.7853) * uv : uv;
  float cheb = max(abs(su.x), abs(su.y));
  float sqBand = smoothstep(0.018, 0.004, abs(cheb - uShock.x * 1.2));
  if (uShock.w >= 0.7) {
    float cornerness = min(abs(su.x), abs(su.y)) / max(cheb, 1e-4);
    sqBand *= step(0.55, cornerness);
  }
  float sAmp = uShock.y * exp(-uShock.x * 2.6);
  col += accent * sqBand * sAmp * 0.7 * uShock.z;

  // Scanner sweeps: slow bands that brighten what they cross — texture
  // reveals itself in passes instead of sitting static.
  float sx = fract(uTime * 0.045) * 2.0 - 1.0;
  float sweep = exp(-abs(uv.x / asp * 2.0 - sx * 1.1) * 18.0);
  float sy = fract(uTime * 0.019) * 2.0 - 1.0;
  float sweepY = exp(-abs(uv.y * 2.0 - sy * 1.1) * 18.0);
  col *= 1.0 + sweep * 1.4 + sweepY * 0.7;
  col += accent * sweep * 0.02;

  // Osc note: vertical hairline at its pitch-class x position.
  if (uNote.z > 0.001) {
    float nx = (uNote.x - 0.5) * asp * 0.9;
    col += accent * smoothstep(0.004, 0.0, abs(uv.x - nx)) * uNote.z * exp(-uNote.y * 3.0) * 0.4;
  }

  vec3 prev = texture(uPrev, vUv).rgb;
  col = max(col, prev * uA.w);
  frag = vec4(col, 1.0);
}
`;

const VIZ_POST_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 frag;
uniform sampler2D uTex;
uniform vec2 uRes;
uniform float uTime;
uniform float uBeat;
uniform float uLevel;
uniform vec4 uLook; // x bloom, y aberration scale, z grain, w base exposure

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main() {
  vec2 uv = vUv;
  vec2 c = uv - 0.5;
  float r2 = dot(c, c);
  float ca = (0.0012 + uBeat * 0.010 + uLevel * 0.0015) * uLook.y;
  vec3 col;
  col.r = texture(uTex, uv + c * ca).r;
  col.g = texture(uTex, uv).g;
  col.b = texture(uTex, uv - c * ca).b;
  vec2 px = 2.0 / uRes;
  vec3 bl =
    texture(uTex, uv + vec2(px.x, 0.0)).rgb + texture(uTex, uv - vec2(px.x, 0.0)).rgb +
    texture(uTex, uv + vec2(0.0, px.y)).rgb + texture(uTex, uv - vec2(0.0, px.y)).rgb +
    texture(uTex, uv + px).rgb + texture(uTex, uv - px).rgb +
    texture(uTex, uv + vec2(px.x, -px.y)).rgb + texture(uTex, uv + vec2(-px.x, px.y)).rgb;
  col += bl * uLook.x;
  col = aces(col * (uLook.w + uBeat * 0.25 + uLevel * 0.12));
  col *= 1.0 - r2 * 1.05;
  col += (hash(uv * uRes + fract(uTime) * 113.0) - 0.5) * uLook.z;
  frag = vec4(col, 1.0);
}
`;

// Visual moods: targets the running params lerp toward. dur in seconds.
export const VIZGL_SCENES = [
  { label: 'NEON TUNNEL', dur: [24, 40], speed: 1.5, fold: 0.92, twist: 0.16, decay: 0.84, glow: 1.0, ring: 0.8, warp: 1.0, wave: 0.7, hueVel: 0.012, stars: 0.5 },
  { label: 'HYPER RUSH',  dur: [16, 28], speed: 3.4, fold: 0.72, twist: 0.34, decay: 0.885, glow: 0.85, ring: 0.45, warp: 2.4, wave: 0.4, hueVel: 0.05, stars: 0.9 },
  { label: 'CATHEDRAL',   dur: [26, 44], speed: 0.65, fold: 1.28, twist: 0.045, decay: 0.82, glow: 1.3, ring: 1.0, warp: 0.4, wave: 0.9, hueVel: 0.004, stars: 0.3 },
  { label: 'PRISM STORM', dur: [14, 26], speed: 2.3, fold: 0.55, twist: 0.6, decay: 0.85, glow: 0.95, ring: 1.3, warp: 1.6, wave: 0.5, hueVel: 0.09, stars: 0.35 },
  { label: 'DEEP FIELD',  dur: [28, 48], speed: 0.4, fold: 1.55, twist: 0.02, decay: 0.88, glow: 0.55, ring: 1.5, warp: 0.25, wave: 1.2, hueVel: 0.002, stars: 1.3 },
];
export const VIZGL_PARAM_KEYS = ['speed', 'fold', 'twist', 'decay', 'glow', 'ring', 'warp', 'wave', 'hueVel', 'stars'];

// MINIMAL moods — same keys, remapped: fold = grid scale, twist = rotate rate,
// decay = phosphor persistence, glow = grid lines, ring = spectrum bars,
// warp = cell flicker, wave = oscilloscope. stars unused.
export const VIZMIN_SCENES = [
  { label: 'GRID',   dur: [24, 40], speed: 1.0, fold: 12, twist: 0.0,   decay: 0.55, glow: 1.0,  ring: 0.0,  warp: 0.6, wave: 0.15, hueVel: 0.001,  stars: 0.6 },
  { label: 'FRAMES', dur: [20, 36], speed: 1.0, fold: 14, twist: 0.0,   decay: 0.4,  glow: 0.25, ring: 1.0,  warp: 0.2, wave: 0.0,  hueVel: 0.0015, stars: 0.3 },
  { label: 'SIGNAL', dur: [20, 36], speed: 1.0, fold: 8,  twist: 0.0,   decay: 0.7,  glow: 0.15, ring: 0.25, warp: 0.1, wave: 1.0,  hueVel: 0.001,  stars: 0.2 },
  { label: 'CELLS',  dur: [16, 30], speed: 1.4, fold: 22, twist: 0.004, decay: 0.5,  glow: 0.4,  ring: 0.2,  warp: 1.4, wave: 0.0,  hueVel: 0.003,  stars: 1.0 },
  { label: 'DRIFT',  dur: [26, 44], speed: 0.6, fold: 10, twist: 0.012, decay: 0.75, glow: 0.6,  ring: 0.4,  warp: 0.3, wave: 0.3,  hueVel: 0.0008, stars: 0.5 },
];

export const VIZGL = {
  gl: null,
  failed: false,
  lost: false,
  cssW: 0,
  cssH: 0,
  simW: 0,
  simH: 0,
  progSim: null,
  progMin: null,
  progPost: null,
  uniSim: null,
  uniMin: null,
  uniPost: null,
  style: 'psy', // 'psy' (psychair) | 'min' (minimal)
  styleBtns: null,
  texA: null,
  texB: null,
  fbA: null,
  fbB: null,
  audioTex: null,
  audioBytes: new Uint8Array(512 * 2),
  floatFbo: false,
  labelEl: null,
  labelTimer: 0,
  t: 0,
  lastNow: 0,
  hue: 0.58,
  bass: 0,
  mid: 0,
  high: 0,
  level: 0,
  beat: 0,
  beatAvg: 0,
  beatCooldown: 0,
  wanderT: 0,
  starT: 0,
  kickX: 0,
  kickY: 0,
  events: [],
  lastEventT: -10,
  shockAge: 10,
  shockAmp: 0,
  shockSeed: 0,
  kickHeat: 0,
  glint: 0,
  noteAngle: 0.5,
  noteAge: 10,
  noteAmp: 0,
  camX: 0,
  camY: 0,
  sceneIdx: 0,
  sceneTimer: 0,
  sceneDur: 30,
  p: { speed: 1.5, fold: 0.92, twist: 0.16, decay: 0.84, glow: 1.0, ring: 0.8, warp: 1.0, wave: 0.7, hueVel: 0.012, stars: 0.5 },
};

function vizGLCompile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.warn('viz shader:', gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

function vizGLProgram(gl, fragSrc) {
  const vs = vizGLCompile(gl, gl.VERTEX_SHADER, VIZ_VERT_SRC);
  const fs = vizGLCompile(gl, gl.FRAGMENT_SHADER, fragSrc);
  if (!vs || !fs) return null;
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.warn('viz link:', gl.getProgramInfoLog(prog));
    return null;
  }
  return prog;
}

function vizGLUniforms(gl, prog, names) {
  const out = {};
  names.forEach((n) => (out[n] = gl.getUniformLocation(prog, n)));
  return out;
}

export function resizeVizGLTargets(w, h) {
  const gl = VIZGL.gl;
  [VIZGL.texA, VIZGL.texB].forEach((t) => t && gl.deleteTexture(t));
  [VIZGL.fbA, VIZGL.fbB].forEach((f) => f && gl.deleteFramebuffer(f));
  const make = () => {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const internal = VIZGL.floatFbo ? gl.RGBA16F : gl.RGBA8;
    const type = VIZGL.floatFbo ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, gl.RGBA, type, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fb };
  };
  let a = make();
  let b = make();
  gl.bindFramebuffer(gl.FRAMEBUFFER, a.fb);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE && VIZGL.floatFbo) {
    // Half-float rendering unsupported after all — rebuild the pair as RGBA8.
    VIZGL.floatFbo = false;
    [a.tex, b.tex].forEach((t) => gl.deleteTexture(t));
    [a.fb, b.fb].forEach((f) => gl.deleteFramebuffer(f));
    a = make();
    b = make();
  }
  VIZGL.texA = a.tex;
  VIZGL.fbA = a.fb;
  VIZGL.texB = b.tex;
  VIZGL.fbB = b.fb;
  VIZGL.simW = w;
  VIZGL.simH = h;
}

function setupVizGLResources() {
  const gl = VIZGL.gl;
  VIZGL.floatFbo = !!gl.getExtension('EXT_color_buffer_float');
  VIZGL.progSim = vizGLProgram(gl, VIZ_SIM_FRAG);
  VIZGL.progMin = vizGLProgram(gl, VIZ_MIN_FRAG);
  VIZGL.progPost = vizGLProgram(gl, VIZ_POST_FRAG);
  if (!VIZGL.progSim || !VIZGL.progMin || !VIZGL.progPost) return;
  const simUniformNames = [
    'uPrev', 'uAudio', 'uRes', 'uTime', 'uBass', 'uMid', 'uHigh', 'uLevel', 'uBeat', 'uHue', 'uCam', 'uA', 'uB', 'uStars', 'uStarT', 'uShock', 'uGlint', 'uNote',
  ];
  VIZGL.uniSim = vizGLUniforms(gl, VIZGL.progSim, simUniformNames);
  VIZGL.uniMin = vizGLUniforms(gl, VIZGL.progMin, simUniformNames);
  VIZGL.uniPost = vizGLUniforms(gl, VIZGL.progPost, ['uTex', 'uRes', 'uTime', 'uBeat', 'uLevel', 'uLook']);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  VIZGL.audioTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, VIZGL.audioTex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 512, 2, 0, gl.RED, gl.UNSIGNED_BYTE, null);
  VIZGL.simW = 0; // force render-target rebuild on the next frame
}

export function initVizGL(canvas) {
  if (!canvas || VIZGL.failed || VIZGL.gl) return;
  const gl = canvas.getContext('webgl2', {
    antialias: false,
    alpha: false,
    depth: false,
    powerPreference: 'high-performance',
  });
  if (!gl) {
    VIZGL.failed = true;
    return;
  }
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    VIZGL.lost = true;
  });
  canvas.addEventListener('webglcontextrestored', () => {
    VIZGL.lost = false;
    setupVizGLResources();
  });
  VIZGL.gl = gl;
  setupVizGLResources();
  if (!VIZGL.progSim || !VIZGL.progMin || !VIZGL.progPost) {
    // Shaders refused to build; the canvas is stuck bound to WebGL, so the 2D
    // fallback can't claim it — keep the GL loop alive but render nothing.
    VIZGL.failed = true;
    VIZGL.lost = true;
  }
}

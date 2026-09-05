// The face view's picture: a kaleidoscopic, domain-warped field on a
// fullscreen WebGL quad, driven by the same features that drive the synth.
// Mouth opens an iris, width sets the mirror count, brows add turbulence,
// turn spins, tilt zooms, roll shears, a blink flashes, the chord sets the
// palette, and the audio level pulses the rings. No face → slow ambient.

const VERT = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const FRAG = `
precision highp float;
uniform vec2 u_res;
uniform float u_time;
uniform float u_mouth, u_wide, u_brows, u_yaw, u_tilt, u_roll, u_eyes;
uniform float u_flash, u_level, u_hue, u_face, u_cutoff;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 m = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = m * p * 2.03 + 11.7;
    a *= 0.5;
  }
  return v;
}
vec3 pal(float t) {
  return 0.5 + 0.5 * cos(6.28318 * (vec3(1.0, 1.0, 1.0) * t + vec3(0.0, 0.33, 0.67) + u_hue));
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y;
  float face = u_face;

  // Head: roll shears, turn spins, tilt zooms.
  float ang = u_roll * 0.7 + u_yaw * 1.6 + u_time * (0.03 + 0.05 * face);
  uv = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * uv;
  uv *= 1.0 + u_tilt * 0.7 * face;
  uv.x *= 1.0 + u_roll * 0.25 * face;

  // Kaleidoscope: mouth width picks the mirror count.
  float seg = floor(3.0 + u_wide * 9.0 * face + 3.0 * (1.0 - face));
  float a = atan(uv.y, uv.x);
  float r = length(uv);
  float k = 6.28318 / seg;
  a = abs(mod(a, k) - k * 0.5);
  vec2 p = vec2(cos(a), sin(a)) * r;

  // Domain warp; brows crank the turbulence, the audio level stirs it.
  float t = u_time * 0.25;
  vec2 q = vec2(fbm(p * 3.0 + t), fbm(p * 3.0 - t * 0.7 + 4.2));
  vec2 w = p + (0.35 + u_brows * 1.6 * face + u_level * 0.6) * (q - 0.5) * 2.0;
  float n = fbm(w * 4.0 + u_level * 1.5);

  // Iris: the mouth opens a void at the centre that breathes with the level.
  float hole = (u_mouth * 0.42 + u_level * 0.08) * face;
  float iris = smoothstep(hole, hole + 0.06, r);
  float rim = smoothstep(hole + 0.10, hole, r) * smoothstep(hole - 0.02, hole, r);

  // Rings: cutoff sets their density, they roll outward with time.
  float rings = 0.5 + 0.5 * sin(r * (14.0 + u_cutoff * 70.0) - u_time * 3.5 - n * 7.0);
  rings = pow(rings, 1.5 + 2.5 * (1.0 - u_level));

  vec3 col = pal(n * 1.4 + r * 0.35 + u_time * 0.02) * (0.25 + 0.95 * rings);
  col *= iris;
  col += pal(0.5 + u_hue) * rim * (0.6 + u_level);
  col += vec3(1.0) * u_flash * exp(-r * 2.2);
  col *= 0.35 + 0.65 * face;
  // Vignette and a touch of contrast.
  col *= 1.0 - smoothstep(0.55, 1.2, r) * 0.7;
  col = pow(max(col, 0.0), vec3(1.1));
  gl_FragColor = vec4(col, 1.0);
}
`;

const UNIFORMS = [
  'u_res', 'u_time', 'u_mouth', 'u_wide', 'u_brows', 'u_yaw', 'u_tilt', 'u_roll', 'u_eyes',
  'u_flash', 'u_level', 'u_hue', 'u_face', 'u_cutoff',
];

export function createFaceVisual(canvas) {
  const gl = canvas.getContext('webgl', { antialias: false, alpha: false, preserveDrawingBuffer: false });
  if (!gl) return null;

  const compile = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error(`face shader: ${log}`);
    }
    return sh;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(`face shader link: ${gl.getProgramInfoLog(prog)}`);
  }
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, 'a_pos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  const loc = Object.fromEntries(UNIFORMS.map((u) => [u, gl.getUniformLocation(prog, u)]));

  const t0 = performance.now();
  return {
    resize(w, h) {
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      gl.viewport(0, 0, w, h);
    },
    // Every value 0..1 except the bipolar head axes (-1..1) and hue (turns).
    frame(u) {
      gl.uniform2f(loc.u_res, canvas.width, canvas.height);
      gl.uniform1f(loc.u_time, (performance.now() - t0) / 1000);
      gl.uniform1f(loc.u_mouth, u.mouth);
      gl.uniform1f(loc.u_wide, u.wide);
      gl.uniform1f(loc.u_brows, u.brows);
      gl.uniform1f(loc.u_yaw, u.yaw);
      gl.uniform1f(loc.u_tilt, u.tilt);
      gl.uniform1f(loc.u_roll, u.roll);
      gl.uniform1f(loc.u_eyes, u.eyes);
      gl.uniform1f(loc.u_flash, u.flash);
      gl.uniform1f(loc.u_level, u.level);
      gl.uniform1f(loc.u_hue, u.hue);
      gl.uniform1f(loc.u_face, u.face);
      gl.uniform1f(loc.u_cutoff, u.cutoff);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    dispose() {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}

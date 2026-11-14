// Copied as is from karuna-site/src/components/ContourField.tsx (the shader and renderer), minus the React wrapper.
// Keep in sync with the site; don't restyle here.
import { compile, fullscreenTriangle, type GL } from "./gl.ts";

const vertex = `
attribute vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }
`;

// Two levels of domain-warped fbm simplex noise, shaded like light on silk, with contour lines.
const fragment = `
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform vec3 uMouse;
uniform float uVariant;

vec3 perm(vec3 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865, 0.366025404, -0.577350269, 0.024390244);
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = x0.x > x0.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);
  vec3 p = perm(perm(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m * m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 a0 = x - floor(x + 0.5);
  m *= 1.79284291 - 0.85373472 * (a0 * a0 + h * h);
  vec3 g = vec3(a0.x * x0.x + h.x * x0.y, a0.yz * x12.xz + h.yz * x12.yw);
  return 130.0 * dot(m, g);
}
float fbm(vec2 p) {
  float f = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    f += a * snoise(p);
    p = p * 2.03 + vec2(1.7, 9.2);
    a *= 0.5;
  }
  return f;
}

// Topographic variant: a slow single-warped terrain drawn only as evenly spaced isolines.
vec3 topo() {
  vec2 uv = gl_FragCoord.xy / uRes.y;
  vec2 p = uv * 1.25 + vec2(3.1, -1.7);
  float t = uTime * 0.018;

  vec2 m = uMouse.xy / uRes.y;
  vec2 d = uv - m;
  p += d * exp(-dot(d, d) * 9.0) * 0.18 * uMouse.z;

  vec2 q = vec2(fbm(p + vec2(t, 0.0)), fbm(p + vec2(4.3, 7.1) - t));
  float h = fbm(p + 0.6 * q) * 0.5 + 0.5;

  float x = gl_FragCoord.x / uRes.x;
  float focus = mix(0.35, 1.0, smoothstep(0.35, 0.9, x));

  float bands = h * 30.0;
  float w = fwidth(bands);
  float line = 1.0 - smoothstep(0.0, w * 1.1, min(fract(bands), 1.0 - fract(bands)));
  float idx = bands / 5.0;
  float major = 1.0 - smoothstep(0.0, fwidth(idx) * 1.8, min(fract(idx), 1.0 - fract(idx)));

  vec3 col = vec3(1.0 - smoothstep(0.5, 0.95, h) * 0.08 * focus);
  col = mix(col, vec3(0.12), line * 0.34 * focus);
  col = mix(col, vec3(0.05), major * 0.7 * focus);
  return col;
}

void main() {
  if (uVariant > 0.5) {
    gl_FragColor = vec4(topo(), 1.0);
    return;
  }
  vec2 uv = gl_FragCoord.xy / uRes.y;
  vec2 p = uv * 0.62;
  float t = uTime * 0.03;

  vec2 m = uMouse.xy / uRes.y;
  vec2 d = uv - m;
  p -= d * exp(-dot(d, d) * 10.0) * 0.2 * uMouse.z;

  // Two levels of domain warping give the marbled, folded look.
  vec2 q = vec2(fbm(p + vec2(0.0, t)), fbm(p + vec2(5.2, 1.3) - t));
  vec2 r = vec2(fbm(p + 1.7 * q + vec2(1.7, 9.2) + 0.6 * t), fbm(p + 1.7 * q + vec2(8.3, 2.8) - 0.5 * t));
  float v = fbm(p + 1.5 * r) * 0.5 + 0.5;

  float x = gl_FragCoord.x / uRes.x;
  float focus = mix(0.4, 1.0, smoothstep(0.25, 0.8, x));

  // Stepped gray fills with a soft silk sheen inside each band.
  float levels = 8.0;
  float s = v * levels;
  float band = floor(s);
  float fill = smoothstep(3.0, 7.0, band) * 0.42 + step(5.0, band) * mod(band, 2.0) * 0.1;
  vec2 grad = vec2(dFdx(v), dFdy(v)) * uRes.y * 0.5;
  float sheen = clamp(dot(normalize(vec3(-grad, 1.0)), normalize(vec3(-0.4, 0.6, 0.7))), 0.0, 1.0);
  vec3 col = vec3(1.0 - fill * focus + (sheen - 0.85) * 0.1 * focus);

  // Dark isolines on every band edge, plus fine secondary lines between them.
  float w = fwidth(s);
  float edge = 1.0 - smoothstep(0.0, w * 1.3, min(fract(s), 1.0 - fract(s)));
  float s2 = s * 2.0;
  float w2 = fwidth(s2);
  float fine = 1.0 - smoothstep(0.0, w2, min(fract(s2), 1.0 - fract(s2)));
  float lift = smoothstep(0.3, 0.5, v);
  col = mix(col, vec3(0.05), edge * 0.85 * focus * lift);
  col = mix(col, vec3(0.25), fine * 0.12 * focus * smoothstep(0.5, 0.7, v));

  gl_FragColor = vec4(col, 1.0);
}
`;

type Variant = "marble" | "topo";

export function createContour(gl: GL, variant: Variant) {
  const program = compile(gl, vertex, fragment);
  const draw = fullscreenTriangle(gl, program);
  const uVariant = gl.getUniformLocation(program, "uVariant");
  const uRes = gl.getUniformLocation(program, "uRes");
  const uTime = gl.getUniformLocation(program, "uTime");
  const uMouse = gl.getUniformLocation(program, "uMouse");
  let width = 1;
  let height = 1;
  const target = { x: 0, y: 0, amount: 0 };
  const mouse = { x: 0, y: 0, amount: 0 };

  return {
    resize(w: number, h: number) {
      width = w;
      height = h;
      gl.viewport(0, 0, w, h);
    },
    pointer(x: number, y: number, inside: boolean) {
      target.x = x;
      target.y = height - y;
      target.amount = inside ? 1 : 0;
    },
    frame(t: number, dt: number) {
      const ease = 1 - Math.exp(-dt * 2.5);
      mouse.x += (target.x - mouse.x) * ease;
      mouse.y += (target.y - mouse.y) * ease;
      mouse.amount += (target.amount - mouse.amount) * ease;
      gl.useProgram(program);
      gl.uniform2f(uRes, width, height);
      gl.uniform1f(uVariant, variant === "topo" ? 1 : 0);
      gl.uniform1f(uTime, t + 40);
      gl.uniform3f(uMouse, mouse.x, mouse.y, mouse.amount);
      draw();
    },
    destroy() {
      gl.deleteProgram(program);
    },
  };
}

export const creators: Record<Variant, (gl: GL) => ReturnType<typeof createContour>> = {
  marble: (gl) => createContour(gl, "marble"),
  topo: (gl) => createContour(gl, "topo"),
};


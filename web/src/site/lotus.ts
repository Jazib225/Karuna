// Copied as is from karuna-site/src/components/DitherLotus.tsx (the shader and renderer), minus the React wrapper.
// Keep in sync with the site; don't restyle here.
import { compile, type GL } from "./gl.ts";

const vertex = `
attribute vec3 aPos;
attribute vec3 aNormal;
uniform mat4 uModel;
uniform mat4 uViewProj;
varying vec3 vNormal;
void main() {
  vNormal = (uModel * vec4(aNormal, 0.0)).xyz;
  gl_Position = uViewProj * uModel * vec4(aPos, 1.0);
}
`;

// Lit, then quantized to three grays with an ordered 8x8 Bayer dither.
const fragment = `
precision mediump float;
varying vec3 vNormal;
float bayer2(vec2 a) { a = floor(a); return fract(dot(a, vec2(0.5, a.y * 0.75))); }
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
float bayer8(vec2 a) { return bayer4(0.5 * a) * 0.25 + bayer2(a); }
void main() {
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  float diffuse = max(dot(n, normalize(vec3(-0.45, 0.75, 0.55))), 0.0);
  float fill = max(dot(n, normalize(vec3(0.6, 0.1, 0.8))), 0.0) * 0.25;
  float rim = pow(1.0 - abs(n.z), 2.0) * 0.3;
  float light = clamp(0.08 + diffuse * 0.8 + fill + rim, 0.0, 1.0);
  float level = light * 2.0;
  float base = floor(level);
  float bump = fract(level) > bayer8(gl_FragCoord.xy) ? 1.0 : 0.0;
  float q = min(base + bump, 2.0);
  vec3 col = q < 0.5 ? vec3(0.29) : q < 1.5 ? vec3(0.6) : vec3(0.96);
  gl_FragColor = vec4(col, 1.0);
}
`;

type Ring = { count: number; tilt: number; length: number; width: number; yaw: number; y: number };

const rings: Ring[] = [
  { count: 3, tilt: 0.18, length: 1.0, width: 0.3, yaw: 0, y: 0 },
  { count: 6, tilt: 0.62, length: 0.95, width: 0.32, yaw: Math.PI / 6, y: 0 },
  { count: 8, tilt: 1.08, length: 0.82, width: 0.3, yaw: Math.PI / 8, y: 0.02 },
  { count: 10, tilt: 1.42, length: 0.68, width: 0.26, yaw: 0, y: 0.04 },
];

function buildLotus() {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const U = 14;
  const V = 8;

  const petalPoint = (u: number, v: number, ring: Ring, yaw: number) => {
    const w = ring.width * Math.pow(Math.sin(Math.PI * Math.min(u, 0.999)), 0.75) * (1 - 0.25 * u);
    let px = v * w;
    let py = u * ring.length;
    let pz = 0.55 * (1 - v * v) * w + 0.18 * u * u;
    // lean outward around X, then place around the center (Y)
    const ct = Math.cos(ring.tilt);
    const st = Math.sin(ring.tilt);
    [py, pz] = [py * ct - pz * st, py * st + pz * ct];
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    [px, pz] = [px * cy + pz * sy, -px * sy + pz * cy];
    return [px, py + ring.y, pz];
  };

  for (const ring of rings) {
    for (let k = 0; k < ring.count; k++) {
      const yaw = ring.yaw + (k / ring.count) * Math.PI * 2;
      const start = positions.length / 3;
      for (let i = 0; i <= U; i++) {
        for (let j = 0; j <= V; j++) {
          const u = i / U;
          const v = (j / V) * 2 - 1;
          const p = petalPoint(u, v, ring, yaw);
          const du = petalPoint(Math.min(1, u + 0.01), v, ring, yaw);
          const dv = petalPoint(u, Math.min(1, v + 0.01), ring, yaw);
          const a = [du[0] - p[0], du[1] - p[1], du[2] - p[2]];
          const b = [dv[0] - p[0], dv[1] - p[1], dv[2] - p[2]];
          const n = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
          const len = Math.hypot(n[0], n[1], n[2]) || 1;
          positions.push(...p);
          normals.push(n[0] / len, n[1] / len, n[2] / len);
        }
      }
      for (let i = 0; i < U; i++) {
        for (let j = 0; j < V; j++) {
          const a = start + i * (V + 1) + j;
          const b = a + V + 1;
          indices.push(a, b, a + 1, b, b + 1, a + 1);
        }
      }
    }
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint16Array(indices) };
}

type Mat = Float32Array;
const multiply = (a: Mat, b: Mat) => {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return out;
};
const rotateX = (a: number) => new Float32Array([1, 0, 0, 0, 0, Math.cos(a), Math.sin(a), 0, 0, -Math.sin(a), Math.cos(a), 0, 0, 0, 0, 1]);
const rotateY = (a: number) => new Float32Array([Math.cos(a), 0, -Math.sin(a), 0, 0, 1, 0, 0, Math.sin(a), 0, Math.cos(a), 0, 0, 0, 0, 1]);
const translate = (x: number, y: number, z: number) => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
const perspective = (fov: number, aspect: number, near: number, far: number) => {
  const f = 1 / Math.tan(fov / 2);
  const nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
};

export function createLotus(gl: GL) {
  const program = compile(gl, vertex, fragment);
  const mesh = buildLotus();
  const position = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, position);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
  const normal = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, normal);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.normals, gl.STATIC_DRAW);
  const index = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, index);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(program, "aPos");
  const aNormal = gl.getAttribLocation(program, "aNormal");
  const uModel = gl.getUniformLocation(program, "uModel");
  const uViewProj = gl.getUniformLocation(program, "uViewProj");

  let width = 1;
  let height = 1;
  const target = { x: 0, y: 0 };
  const tilt = { x: 0, y: 0 };

  return {
    resize(w: number, h: number) {
      width = w;
      height = h;
      gl.viewport(0, 0, w, h);
    },
    pointer(x: number, y: number) {
      target.x = Math.max(-1, Math.min(1, (x / width - 0.5) * 2));
      target.y = Math.max(-1, Math.min(1, (y / height - 0.5) * 2));
    },
    frame(t: number, dt: number) {
      const ease = 1 - Math.exp(-dt * 2);
      tilt.x += (target.x - tilt.x) * ease;
      tilt.y += (target.y - tilt.y) * ease;
      const spin = (t / 20) * Math.PI * 2;
      const model = multiply(rotateX(0.42 + tilt.y * 0.18), multiply(rotateY(spin + tilt.x * 0.3), translate(0, -0.45, 0)));
      const viewProj = multiply(perspective(0.62, width / height, 0.1, 20), translate(0, 0, -3.6));

      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.useProgram(program);
      gl.uniformMatrix4fv(uModel, false, model);
      gl.uniformMatrix4fv(uViewProj, false, viewProj);
      gl.bindBuffer(gl.ARRAY_BUFFER, position);
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, normal);
      gl.enableVertexAttribArray(aNormal);
      gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, index);
      gl.drawElements(gl.TRIANGLES, mesh.indices.length, gl.UNSIGNED_SHORT, 0);
    },
    destroy() {
      gl.deleteBuffer(position);
      gl.deleteBuffer(normal);
      gl.deleteBuffer(index);
      gl.deleteProgram(program);
    },
  };
}

export const contextAttributes: WebGLContextAttributes = { antialias: false, alpha: true, premultipliedAlpha: true };


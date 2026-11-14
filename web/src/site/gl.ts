export type GL = WebGLRenderingContext | WebGL2RenderingContext;

export type Renderer = {
  /** t: seconds since start, dt: seconds since last frame. */
  frame: (t: number, dt: number) => void;
  resize: (width: number, height: number) => void;
  pointer?: (x: number, y: number, inside: boolean) => void;
  destroy?: () => void;
};

export function compile(gl: GL, vertex: string, fragment: string) {
  const make = (type: number, source: string) => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader) ?? "shader compile failed");
    }
    return shader;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, make(gl.VERTEX_SHADER, shaderSource(gl, vertex, "vertex")));
  gl.attachShader(program, make(gl.FRAGMENT_SHADER, shaderSource(gl, fragment, "fragment")));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) ?? "program link failed");
  }
  return program;
}

export const isWebGL2 = (gl: GL): gl is WebGL2RenderingContext =>
  typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;

/** Shaders are written in GLSL ES 1.00; on WebGL2 they are upgraded so derivatives work without extensions. */
export function shaderSource(gl: GL, source: string, stage: "vertex" | "fragment") {
  if (!isWebGL2(gl)) {
    if (stage === "fragment" && source.includes("fwidth")) {
      gl.getExtension("OES_standard_derivatives");
      return `#extension GL_OES_standard_derivatives : enable\n${source}`;
    }
    return source;
  }
  let out = source
    .replace(/\battribute\b/g, "in")
    .replace(/\btexture2D\b/g, "texture");
  if (stage === "vertex") out = out.replace(/\bvarying\b/g, "out");
  else {
    out = out.replace(/\bvarying\b/g, "in").replace(/\bgl_FragColor\b/g, "fragColor");
    // The output declaration needs a float precision in scope, so it goes after the precision statement.
    out = /precision\s+\w+\s+float;/.test(out)
      ? out.replace(/precision\s+\w+\s+float;/, (m) => `${m}\nout vec4 fragColor;`)
      : `precision highp float;\nout vec4 fragColor;\n${out}`;
  }
  return `#version 300 es\n${out}`;
}

/** Full-screen triangle; bind to an attribute named `p`. */
export function fullscreenTriangle(gl: GL, program: WebGLProgram) {
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(program, "p");
  return () => {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
}

let support: boolean | null = null;
/** True only with hardware acceleration: software rasterizers (SwiftShader, llvmpipe) get the static frames. */
export function webglSupported() {
  if (support !== null) return support;
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    const info = gl?.getExtension("WEBGL_debug_renderer_info");
    const renderer = info && gl ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
    const software = /swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer);
    const forced = new URLSearchParams(window.location.search).has("webgl");
    support = !!gl && (!software || forced);
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    support = false;
  }
  return support;
}

let gate: Promise<void> | null = null;
/**
 * Resolves after load on the visitor's first interaction, or once the page has sat idle for a few seconds.
 * WebGL context creation and shader compiles are expensive, so they never compete with first paint or hydration.
 */
export function whenVisualsAllowed() {
  gate ??= new Promise((resolve) => {
    const events = ["pointerdown", "pointermove", "keydown", "scroll", "wheel", "touchstart"] as const;
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      events.forEach((e) => window.removeEventListener(e, go));
      resolve();
    };
    const afterLoad = () => {
      events.forEach((e) => window.addEventListener(e, go, { once: true, passive: true }));
      setTimeout(() => ("requestIdleCallback" in window ? requestIdleCallback(go, { timeout: 2000 }) : go()), 4000);
    };
    if (document.readyState === "complete") afterLoad();
    else window.addEventListener("load", afterLoad, { once: true });
  });
  return gate;
}

export function lowPower() {
  const cores = navigator.hardwareConcurrency ?? 8;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  return cores <= 4 || memory <= 4;
}

// Only the most visible registered canvas renders; the rest stay paused.
type Entry = { ratio: number; setRunning: (running: boolean) => void };
const entries = new Map<number, Entry>();
let nextId = 1;

function schedule() {
  let best = 0;
  let bestRatio = 0;
  for (const [id, entry] of entries) {
    if (entry.ratio > bestRatio) {
      best = id;
      bestRatio = entry.ratio;
    }
  }
  for (const [id, entry] of entries) entry.setRunning(id === best);
}

export function register(setRunning: (running: boolean) => void) {
  const id = nextId++;
  entries.set(id, { ratio: 0, setRunning });
  return {
    update(ratio: number) {
      const entry = entries.get(id);
      if (!entry) return;
      entry.ratio = ratio;
      schedule();
    },
    unregister() {
      entries.delete(id);
      schedule();
    },
  };
}

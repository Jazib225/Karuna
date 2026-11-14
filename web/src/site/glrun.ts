// A small, framework-free stand-in for the site's GLCanvas: mounts a renderer from ./contour.ts or
// ./lotus.ts into a container, sizes it (dpr cap × resolution), and runs it only while started.
// Reduced motion, no WebGL, or a failed compile show the site's static frame instead. Used by the
// console (marbled background in the desktop app) and by the desktop app's island.
import type { GL, Renderer } from "./gl.ts";

export interface GLHandle {
  start(): void;
  stop(): void;
  destroy(): void;
  readonly running: boolean;
}

export function mountGL(
  container: HTMLElement,
  create: (gl: GL, canvas: HTMLCanvasElement) => Renderer | null,
  opts: { fallbackSrc: string; dprCap?: number; resolution?: number; contextAttributes?: WebGLContextAttributes; pixelated?: boolean },
): GLHandle {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const fallback = () => {
    const img = document.createElement("img");
    img.src = opts.fallbackSrc;
    img.alt = "";
    img.setAttribute("aria-hidden", "true");
    img.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;";
    if (opts.pixelated) img.style.imageRendering = "pixelated";
    container.appendChild(img);
    return { start() {}, stop() {}, destroy: () => img.remove(), running: false };
  };
  if (reduced) return fallback();

  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.cssText = `position:absolute;inset:0;width:100%;height:100%;opacity:0;transition:opacity 600ms ease-out;${opts.pixelated ? "image-rendering:pixelated;" : ""}`;
  const attrs = { antialias: true, alpha: true, ...opts.contextAttributes };
  const gl = (canvas.getContext("webgl2", attrs) ?? canvas.getContext("webgl", attrs)) as GL | null;
  let renderer: Renderer | null = null;
  try {
    renderer = gl ? create(gl, canvas) : null;
  } catch {
    renderer = null;
  }
  if (!renderer) return fallback();
  container.appendChild(canvas);

  const size = () => {
    const r = container.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, opts.dprCap ?? 2) * (opts.resolution ?? 1);
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
    renderer!.resize(canvas.width, canvas.height);
  };
  const ro = new ResizeObserver(size);
  ro.observe(container);
  size();

  let raf = 0;
  let running = false;
  let elapsed = 0;
  let last = 0;
  renderer.frame(0, 0);
  // Fade in without waiting for an animation frame (those don't run while a window is hidden).
  void canvas.offsetWidth;
  canvas.style.opacity = "1";
  const loop = (now: number) => {
    if (!running) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    elapsed += dt;
    renderer!.frame(elapsed, dt);
    raf = requestAnimationFrame(loop);
  };
  return {
    start() {
      if (running) return;
      running = true;
      last = performance.now();
      raf = requestAnimationFrame(loop);
    },
    stop() {
      running = false;
      cancelAnimationFrame(raf);
    },
    destroy() {
      running = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer?.destroy?.();
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
      canvas.remove();
    },
    get running() {
      return running;
    },
  };
}

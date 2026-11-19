// Karuna Voice's waveform: what the mic button turns into while a conversation is on.
//
// Several soft sine waves in shades of grey under a solid core line, each pinched to nothing at both
// ends, like a voice assistant's. Monochrome: drawn in the island's own text colour (white on the
// dark theme, near-black on the light one), so it sits on the pill with no background of its own. Their height follows Karuna's own
// voice: they swell while it speaks and settle into a thin straight line when it stops.
// One renderer draws every `canvas.wave` on the page each frame, so a button that's rebuilt (the
// floating card's mic) just needs a fresh canvas.

/** The layers, back to front: opacity (a shade of grey), speed, wavelength (cycles across), height share, phase. */
const LAYERS = [
  { alpha: 0.22, speed: 1.15, cycles: 1.6, share: 0.95, phase: 0.0 },
  { alpha: 0.32, speed: -1.45, cycles: 2.1, share: 0.75, phase: 1.7 },
  { alpha: 0.42, speed: 0.85, cycles: 1.25, share: 1.0, phase: 3.4 },
  { alpha: 0.18, speed: -0.7, cycles: 2.7, share: 0.55, phase: 5.1 },
] as const;

/** "rgb(250, 250, 250)" -> "250, 250, 250" (the canvas's text colour, from the theme). */
const rgbOf = (css: string) => css.match(/\d+(\.\d+)?/g)?.slice(0, 3).join(", ") ?? "250, 250, 250";

/** Each wave fades to nothing at both ends (x from -1 to 1): high in the middle, pinched at the edges. */
const envelope = (x: number) => {
  const k = 4;
  return Math.pow(k / (k + Math.pow(x * 1.6, 4)), k);
};

export class WaveRenderer {
  /** 0..1: how loud Karuna (or, more quietly, the member) is right now. */
  private target = 0;
  private level = 0;
  private t = 0;
  private last = 0;

  /** Set the loudness to follow (smoothed, so the wave swells and settles instead of jumping). */
  setLevel(v: number) {
    this.target = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
  }

  /** Draw every visible wave canvas. Call once per animation frame. */
  frame(now: number) {
    const dt = Math.min(0.1, (now - (this.last || now)) / 1000);
    this.last = now;
    // Rise quickly with the voice, fall more slowly into a straight line.
    const rate = this.target > this.level ? 14 : 4;
    this.level += (this.target - this.level) * Math.min(1, dt * rate);
    this.t += dt * (0.6 + this.level * 2.4); // waves travel faster when it's louder
    for (const c of document.querySelectorAll<HTMLCanvasElement>("canvas.wave")) {
      if (!c.isConnected || !c.getClientRects().length) continue;
      this.draw(c);
    }
  }

  private draw(c: HTMLCanvasElement) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(c.clientWidth * dpr);
    const h = Math.round(c.clientHeight * dpr);
    if (!w || !h) return;
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, w, h);
    const mid = h / 2;
    const amp = h * 0.42 * this.level; // full voice: the waves nearly fill the button
    const steps = Math.max(48, Math.round(w / 2));
    const ink = rgbOf(getComputedStyle(c).color);

    for (const L of LAYERS) {
      const a = amp * L.share;
      if (a < 0.4) continue; // silent: only the core line shows
      // Filled lens between the wave and its mirror, like the reference: bright where layers overlap.
      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const x = (i / steps) * 2 - 1;
        const y = a * envelope(x) * Math.sin(x * Math.PI * L.cycles + this.t * L.speed * 3 + L.phase);
        const px = (i / steps) * w;
        if (i === 0) ctx.moveTo(px, mid - Math.abs(y));
        else ctx.lineTo(px, mid - Math.abs(y));
      }
      for (let i = steps; i >= 0; i--) {
        const x = (i / steps) * 2 - 1;
        const y = a * envelope(x) * Math.sin(x * Math.PI * L.cycles + this.t * L.speed * 3 + L.phase);
        ctx.lineTo((i / steps) * w, mid + Math.abs(y) * 0.85);
      }
      ctx.closePath();
      const g = ctx.createLinearGradient(0, 0, w, 0);
      g.addColorStop(0, `rgba(${ink}, 0)`);
      g.addColorStop(0.25, `rgba(${ink}, ${L.alpha})`);
      g.addColorStop(0.75, `rgba(${ink}, ${L.alpha})`);
      g.addColorStop(1, `rgba(${ink}, 0)`);
      ctx.fillStyle = g;
      ctx.fill();
    }

    // The core: a thin line when quiet, a stronger ribbon when loud.
    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const x = (i / steps) * 2 - 1;
      const y = amp * 0.35 * envelope(x) * Math.sin(x * Math.PI * 1.8 - this.t * 2.2);
      const px = (i / steps) * w;
      if (i === 0) ctx.moveTo(px, mid + y);
      else ctx.lineTo(px, mid + y);
    }
    const core = ctx.createLinearGradient(0, 0, w, 0);
    core.addColorStop(0, `rgba(${ink}, 0)`);
    core.addColorStop(0.2, `rgba(${ink}, 0.95)`);
    core.addColorStop(0.8, `rgba(${ink}, 0.95)`);
    core.addColorStop(1, `rgba(${ink}, 0)`);
    ctx.strokeStyle = core;
    ctx.lineWidth = Math.max(1, dpr * (1 + this.level * 1.6));
    ctx.lineCap = "round";
    ctx.stroke();
  }
}

import type { FaceEmotion } from "../shared/protocol";

type Params = { eyeHeight: number; eyeLift: number; eyeWidth: number; talk: number };

/**
 * Upstream `apps/console/src/landing/face/emotions.ts` gives neutral, curious, focused, and talking.
 * The desk also needs questioning, for the confirmation screen.
 */
const EMOTIONS: Record<FaceEmotion, Params> = {
  neutral: { eyeHeight: 1, eyeLift: 0, eyeWidth: 1, talk: 0 },
  curious: { eyeHeight: 1.18, eyeLift: 0.55, eyeWidth: 0.96, talk: 0 },
  focused: { eyeHeight: 0.42, eyeLift: -0.15, eyeWidth: 1.06, talk: 0 },
  talking: { eyeHeight: 0.88, eyeLift: 0.1, eyeWidth: 1, talk: 0.4 },
  questioning: { eyeHeight: 1.05, eyeLift: 0.35, eyeWidth: 0.92, talk: 0 },
};

const RAMP = " .:-=+*#%@";
const SIZE = 720;
const CELL = 20;
const COLS = SIZE / CELL;

function roundedBox(px: number, py: number, hw: number, hh: number, r: number): number {
  const qx = Math.abs(px) - hw + r;
  const qy = Math.abs(py) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Draws Apollo's eyes from glyph cells on the round screen, like the ASCII face on the upstream landing page. */
export class Face {
  #ctx: CanvasRenderingContext2D;
  #grid: HTMLCanvasElement;
  #now: Params = { ...EMOTIONS.neutral };
  #target: Params = EMOTIONS.neutral;
  #emotion: FaceEmotion = "neutral";
  #accent = "#ffffff";
  #level = 0;
  #timer: number | null = null;
  #hidden = false;
  #blinkAt = performance.now() + 2500;
  #look = { x: 0, y: 0, tx: 0, ty: 0, next: 0 };
  #reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  constructor(canvas: HTMLCanvasElement) {
    this.#ctx = canvas.getContext("2d")!;
    this.#grid = document.createElement("canvas");
    this.#grid.width = this.#grid.height = SIZE;
    const g = this.#grid.getContext("2d")!;
    g.fillStyle = "rgba(255,255,255,0.07)";
    for (let y = 0; y < COLS; y++) for (let x = 0; x < COLS; x++) g.fillRect(x * CELL + CELL / 2 - 1, y * CELL + CELL / 2 - 1, 2, 2);
  }

  setEmotion(emotion: FaceEmotion) {
    this.#emotion = emotion;
    this.#target = EMOTIONS[emotion] ?? EMOTIONS.neutral;
  }

  setAccent(color: string) {
    this.#accent = color;
  }

  /** Audio level from 0 to 1. The mouth follows speech and the ring follows the microphone. */
  setLevel(level: number) {
    this.#level = Math.max(0, Math.min(1, level));
  }

  /** Remaining timer fraction from 0 to 1, or null for no timer. */
  setTimer(fraction: number | null) {
    this.#timer = fraction;
  }

  setHidden(hidden: boolean) {
    this.#hidden = hidden;
  }

  start() {
    const frame = (t: number) => {
      this.#draw(t);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  #draw(t: number) {
    const ctx = this.#ctx;
    const k = 0.14;
    for (const key of Object.keys(this.#now) as (keyof Params)[]) this.#now[key] += (this.#target[key] - this.#now[key]) * k;

    ctx.fillStyle = "#050506";
    ctx.fillRect(0, 0, SIZE, SIZE);
    ctx.drawImage(this.#grid, 0, 0);

    if (this.#timer !== null) {
      ctx.save();
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.lineWidth = 10;
      ctx.beginPath();
      ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2 - 14, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = this.#accent;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2 - 14, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * this.#timer);
      ctx.stroke();
      ctx.restore();
    }

    if (this.#emotion === "curious" && this.#level > 0.02) {
      ctx.save();
      ctx.strokeStyle = this.#accent;
      ctx.globalAlpha = 0.15 + this.#level * 0.7;
      ctx.lineWidth = 4 + this.#level * 14;
      ctx.beginPath();
      ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2 - 34, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    if (this.#hidden) return;

    // Blink every few seconds, and let the gaze drift a little.
    let blink = 1;
    if (!this.#reduced) {
      const since = t - this.#blinkAt;
      if (since > 0 && since < 140) blink = Math.max(0.08, Math.abs(since - 70) / 70);
      else if (since >= 140) this.#blinkAt = t + 2200 + Math.random() * 3800;
      if (t > this.#look.next) {
        const thinking = this.#emotion === "focused";
        this.#look.tx = thinking ? 18 : (Math.random() - 0.5) * 30;
        this.#look.ty = thinking ? -10 : (Math.random() - 0.5) * 16;
        this.#look.next = t + 1400 + Math.random() * 2600;
      }
      this.#look.x += (this.#look.tx - this.#look.x) * 0.06;
      this.#look.y += (this.#look.ty - this.#look.y) * 0.06;
    }

    const p = this.#now;
    const hw = 84 * p.eyeWidth;
    const hh = 112 * p.eyeHeight * blink;
    const cy = 280 - p.eyeLift * 56 + this.#look.y;
    const cx = SIZE / 2 + this.#look.x;
    const eyes = [cx - 150, cx + 150];
    const talking = p.talk > 0.05;
    const mouthH = talking ? 6 + this.#level * 80 * (p.talk / 0.4) : 0;
    const shimmer = this.#emotion === "focused" && !this.#reduced;

    ctx.font = `600 ${CELL}px "JetBrains Mono", ui-monospace, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = this.#accent;

    const x0 = Math.floor((cx - 150 - hw - CELL * 2) / CELL);
    const x1 = Math.ceil((cx + 150 + hw + CELL * 2) / CELL);
    const y0 = Math.floor((cy - Math.max(hh, 120) - CELL * 2) / CELL);
    const y1 = Math.ceil((talking ? 460 + mouthH : cy + hh + CELL * 2) / CELL);

    for (let row = Math.max(0, y0); row < Math.min(COLS, y1); row++) {
      for (let col = Math.max(0, x0); col < Math.min(COLS, x1); col++) {
        const px = col * CELL + CELL / 2;
        const py = row * CELL + CELL / 2;
        let d = Infinity;
        for (const ex of eyes) d = Math.min(d, roundedBox(px - ex, py - cy, hw, Math.max(hh, 4), Math.min(hw, Math.max(hh, 4)) * 0.62));
        if (talking) d = Math.min(d, roundedBox(px - cx, py - 440, 90, mouthH / 2 + 3, Math.min(90, mouthH / 2 + 3)));
        let cover = Math.max(0, Math.min(1, 0.5 - d / (CELL * 1.6)));
        if (cover <= 0.02) continue;
        if (shimmer) cover *= 0.72 + 0.28 * Math.sin(t / 180 + col * 0.7 + row * 0.35);
        const glyph = RAMP[Math.min(RAMP.length - 1, Math.round(cover * (RAMP.length - 1)))]!;
        if (glyph === " ") continue;
        ctx.globalAlpha = 0.35 + cover * 0.65;
        ctx.fillText(glyph, px, py + 1);
      }
    }
    ctx.globalAlpha = 1;
  }
}

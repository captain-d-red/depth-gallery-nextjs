import type { Film } from '@/data/catalogue';

/** Canvas size for one title card. Its world plane keeps the same two-to-one ratio. */
export const TITLE_CANVAS = { width: 1792, height: 896 } as const;
export const TITLE_PLANE = { width: 1.64, height: 0.82 } as const;

export type TitleAlign = 'left' | 'right';

export interface TitleArt {
  /** Glyph coverage, one byte per pixel, rows ordered bottom to top as GL expects. */
  readonly coverage: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** Particle seeds as u, v, a random seed and a size factor, four floats per particle. */
  readonly points: Float32Array;
  readonly count: number;
}

const PAD = 36;

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Sets one film's card: an eyebrow with its genres, the title at the largest size that fits
 * in three lines, then the director and runtime, then the logline. Everything is drawn
 * white, since only coverage is kept and the ink colour is applied in the shader.
 */
export function drawTitleArt(film: Film, fontFamily: string, align: TitleAlign, maxPoints = 6000): TitleArt {
  const { width: W, height: H } = TITLE_CANVAS;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas is unavailable, so titles cannot be set');

  const x = align === 'left' ? PAD : W - PAD;
  const maxWidth = W - PAD * 2;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';

  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = `620 29px ${fontFamily}`;
  ctx.letterSpacing = '6px';
  ctx.fillText(film.genres.slice(0, 3).join('   ').toUpperCase(), x, 54);

  let size = 196;
  let lines: string[] = [];
  for (; size >= 64; size -= 6) {
    ctx.font = `720 ${size}px ${fontFamily}`;
    ctx.letterSpacing = `${(-size * 0.034).toFixed(1)}px`;
    lines = wrap(ctx, film.title, maxWidth);
    if (lines.length <= 3 && lines.every((l) => ctx.measureText(l).width <= maxWidth)) break;
  }
  ctx.fillStyle = '#fff';
  let y = 54 + 26 + size * 0.86;
  for (const line of lines) {
    ctx.fillText(line, x, y);
    y += size * 0.93;
  }

  y += 44 - size * 0.93 + 40;
  ctx.letterSpacing = '0px';
  ctx.font = `560 36px ${fontFamily}`;
  ctx.fillStyle = 'rgba(255,255,255,0.88)';
  ctx.fillText(`${film.director}    ${film.minutes} min`, x, y);
  y += 60;
  ctx.font = `440 33px ${fontFamily}`;
  ctx.fillStyle = 'rgba(255,255,255,0.74)';
  for (const line of wrap(ctx, film.logline, Math.min(maxWidth, 1040)).slice(0, 3)) {
    if (y > H - 20) break;
    ctx.fillText(line, x, y);
    y += 44;
  }

  const rgba = ctx.getImageData(0, 0, W, H).data;
  const coverage = new Uint8Array(W * H);
  for (let row = 0; row < H; row++) {
    const src = row * W * 4;
    const dst = (H - 1 - row) * W;
    for (let col = 0; col < W; col++) coverage[dst + col] = rgba[src + col * 4 + 3] ?? 0;
  }

  // Candidates on a jittered grid inside the glyphs, then a uniform sample of them.
  const stride = 3;
  const candidates: number[] = [];
  for (let py = 0; py < H; py += stride) {
    for (let px = 0; px < W; px += stride) {
      if ((rgba[(py * W + px) * 4 + 3] ?? 0) > 110) candidates.push(py * W + px);
    }
  }
  const count = Math.min(maxPoints, candidates.length);
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(Math.random() * (candidates.length - i));
    const t = candidates[i]!;
    candidates[i] = candidates[j]!;
    candidates[j] = t;
  }
  const points = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const p = candidates[i]!;
    const px = p % W;
    const py = Math.floor(p / W);
    points[i * 4] = (px + Math.random() * stride) / W;
    points[i * 4 + 1] = 1 - (py + Math.random() * stride) / H;
    points[i * 4 + 2] = Math.random();
    points[i * 4 + 3] = 0.6 + Math.random() * 0.9;
  }
  return { coverage, width: W, height: H, points, count };
}

import type { Oklch } from './color';

/**
 * Picks the colours a poster should light the room with. Area alone lies about this: a
 * mustard wall behind the Joker covers more of the poster than his red suit, but the suit is
 * what a viewer remembers. So pixels vote for their hue with weight that rises steeply with
 * chroma, dark and blown-out pixels abstain, and skin is discounted.
 */

const TAU = Math.PI * 2;
const BINS = 36;
/** Pixels within this angle of a family's hue belong to it. */
export const FAMILY_WIDTH = (24 * Math.PI) / 180;
/** An accent must sit at least this far round the wheel from the key. */
const ACCENT_SEPARATION = (55 * Math.PI) / 180;
/** An accent must carry at least this share of the key's vote. */
const ACCENT_SHARE = 0.3;
/** Below this chroma a poster is treated as monochrome. */
export const NEUTRAL_CHROMA = 0.035;

export interface VividPalette {
  readonly key: Oklch;
  /** A second colour, present only when the poster genuinely carries two. */
  readonly accent: Oklch | null;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % TAU;
  return d > Math.PI ? TAU - d : d;
}

/** How strongly one pixel votes, before it is assigned to a hue. */
export function vividWeight({ L, C, h }: Oklch): number {
  const deg = (h * 180) / Math.PI;
  const skin = deg > 25 && deg < 80 && C < 0.11 ? 0.2 : 1;
  return C ** 3 * smoothstep(0.14, 0.34, L) * (1 - smoothstep(0.9, 0.98, L)) * skin;
}

/** Membership of a pixel in the hue family centred on `hue`, from one at the centre to zero at the edge. */
export function familyMembership(pixel: Oklch, hue: number): number {
  return 1 - smoothstep(FAMILY_WIDTH * 0.5, FAMILY_WIDTH, hueDistance(pixel.h, hue));
}

function familyColour(pixels: readonly Oklch[], hue: number): { colour: Oklch; vote: number } {
  let a = 0;
  let b = 0;
  let chroma = 0;
  let vote = 0;
  for (const p of pixels) {
    const w = vividWeight(p) * familyMembership(p, hue);
    a += Math.cos(p.h) * w;
    b += Math.sin(p.h) * w;
    chroma += p.C * w;
    vote += w;
  }
  const h = Math.atan2(b, a);
  return { colour: { L: 0.68, C: vote > 0 ? chroma / vote : 0, h: h < 0 ? h + TAU : h }, vote };
}

export function vividPalette(pixels: readonly Oklch[]): VividPalette {
  const histogram = new Float64Array(BINS);
  for (const p of pixels) histogram[Math.floor((p.h / TAU) * BINS) % BINS]! += vividWeight(p);
  // A circular blur so a hue that straddles two bins is not split in half.
  const smooth = histogram.map((_, i) => {
    let s = 0;
    for (let k = -2; k <= 2; k++) s += histogram[(i + k + BINS) % BINS]! * (3 - Math.abs(k));
    return s;
  });
  const centre = (i: number) => ((i + 0.5) / BINS) * TAU;
  const order = [...smooth.keys()].sort((x, y) => smooth[y]! - smooth[x]!);
  const key = familyColour(pixels, centre(order[0]!));

  if (key.colour.C < NEUTRAL_CHROMA) {
    return { key: { L: 0.72, C: 0.02, h: (70 * Math.PI) / 180 }, accent: null };
  }
  const rival = order.find((i) => hueDistance(centre(i), key.colour.h) >= ACCENT_SEPARATION);
  const accent = rival === undefined ? null : familyColour(pixels, centre(rival));
  const keeps = accent && accent.vote >= key.vote * ACCENT_SHARE && accent.colour.C >= NEUTRAL_CHROMA * 1.5;
  return { key: key.colour, accent: keeps ? accent.colour : null };
}

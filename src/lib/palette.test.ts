import { describe, expect, it } from 'vitest';
import type { Oklch } from './color';
import { hueDistance, vividPalette } from './palette';

const deg = (d: number) => (d * Math.PI) / 180;
const fill = (count: number, pixel: Oklch): Oklch[] => Array.from({ length: count }, () => pixel);

describe('vividPalette', () => {
  it('lets a small vivid red outvote a large dull mustard', () => {
    const pixels = [...fill(600, { L: 0.62, C: 0.09, h: deg(85) }), ...fill(160, { L: 0.55, C: 0.19, h: deg(28) })];
    const { key } = vividPalette(pixels);
    expect(hueDistance(key.h, deg(28))).toBeLessThan(deg(6));
  });

  it('keeps a genuine second colour as the accent', () => {
    const pixels = [...fill(400, { L: 0.6, C: 0.14, h: deg(150) }), ...fill(300, { L: 0.6, C: 0.13, h: deg(200) })];
    const { key, accent } = vividPalette(pixels);
    expect(hueDistance(key.h, deg(150))).toBeLessThan(deg(6));
    expect(accent).not.toBeNull();
    expect(hueDistance(accent!.h, deg(200))).toBeLessThan(deg(6));
  });

  it('drops an accent that is only a trace', () => {
    const pixels = [...fill(800, { L: 0.6, C: 0.16, h: deg(240) }), ...fill(20, { L: 0.6, C: 0.12, h: deg(40) })];
    expect(vividPalette(pixels).accent).toBeNull();
  });

  it('discounts skin so a face never sets the light', () => {
    const pixels = [...fill(900, { L: 0.7, C: 0.07, h: deg(55) }), ...fill(120, { L: 0.5, C: 0.12, h: deg(250) })];
    expect(hueDistance(vividPalette(pixels).key.h, deg(250))).toBeLessThan(deg(8));
  });

  it('falls back to a warm neutral for a monochrome poster', () => {
    const { key, accent } = vividPalette(fill(500, { L: 0.5, C: 0.01, h: deg(260) }));
    expect(key.C).toBeLessThan(0.03);
    expect(accent).toBeNull();
  });
});

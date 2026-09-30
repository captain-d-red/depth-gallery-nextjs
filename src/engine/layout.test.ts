import { describe, expect, it } from 'vitest';
import { FOCUS, GAP, cameraZForPosition, dwell, placeFilm } from './layout';

describe('dwell', () => {
  it('leaves every framed film exactly where it is', () => {
    for (let i = 0; i < 8; i++) expect(dwell(i)).toBeCloseTo(i, 12);
  });

  it('never runs backwards, so scrolling forward always moves the camera forward', () => {
    let previous = -Infinity;
    for (let p = 0; p <= 6; p += 0.001) {
      const value = dwell(p);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it('slows the camera near a film and hurries it between films', () => {
    const step = 1e-4;
    const speed = (p: number) => (dwell(p + step) - dwell(p)) / step;
    expect(speed(0)).toBeLessThan(0.5);
    expect(speed(0.5)).toBeGreaterThan(1.5);
  });
});

describe('placeFilm', () => {
  it('alternates sides of the camera path', () => {
    for (let i = 0; i < 10; i++) {
      const { side, x } = placeFilm(i);
      expect(side).toBe(i % 2 === 0 ? 1 : -1);
      expect(Math.sign(x)).toBe(side);
    }
  });

  it('spaces films one gap apart, receding into the screen', () => {
    expect(placeFilm(3).z).toBe(-3 * GAP);
    expect(cameraZForPosition(3) - placeFilm(3).z).toBeCloseTo(FOCUS, 12);
  });
});

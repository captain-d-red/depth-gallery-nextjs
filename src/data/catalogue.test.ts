import { describe, expect, it } from 'vitest';
import raw from './films.json';
import { assertCatalogue, catalogue } from './catalogue';

describe('catalogue', () => {
  it('runs forward through time', () => {
    const years = catalogue.films.map((f) => f.year);
    expect(years).toEqual([...years].sort((a, b) => a - b));
  });

  it('gives every film a unique slug and atlas cell', () => {
    expect(new Set(catalogue.films.map((f) => f.slug)).size).toBe(catalogue.films.length);
    expect(new Set(catalogue.films.map((f) => f.atlasIndex)).size).toBe(catalogue.films.length);
  });

  it('fails loudly on broken data', () => {
    const broken = structuredClone(raw);
    broken.films[4]!.light.pop();
    expect(() => assertCatalogue(broken)).toThrow(/light samples/);
    expect(() => assertCatalogue({ atlas: {} })).toThrow(/atlas or films/);
  });
});

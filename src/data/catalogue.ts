import raw from './films.json';

/** One light sample on a poster, as linear RGB plus an emission strength. */
export type LightSample = readonly [r: number, g: number, b: number, strength: number];

export interface Film {
  readonly slug: string;
  readonly title: string;
  readonly year: number;
  readonly director: string;
  readonly minutes: number;
  readonly genres: readonly string[];
  readonly logline: string;
  readonly image: { readonly src: string; readonly width: number; readonly height: number };
  /** Cell of this poster in the low-resolution atlas that renders before the full image arrives. */
  readonly atlasIndex: number;
  /**
   * Six light samples laid out in two columns and three rows, read row by row from the
   * top left. The haze is lit by these, so the air around a poster carries its colours.
   */
  readonly light: readonly LightSample[];
  /** Grade chip colours as sRGB hex, the vivid key, a secondary fill and the shadow tone. */
  readonly palette: { readonly key: string; readonly fill: string; readonly shade: string };
  readonly trailer: { readonly id: string; readonly aspect: number } | null;
}

export interface Atlas {
  readonly src: string;
  readonly columns: number;
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly width: number;
  readonly height: number;
}

export interface Catalogue {
  readonly atlas: Atlas;
  readonly films: readonly Film[];
}

export const LIGHT_COLUMNS = 2;
export const LIGHT_ROWS = 3;

function fail(message: string): never {
  throw new Error(`films.json: ${message}`);
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Checks the generated catalogue once at module load, so a broken build of the data
 * fails loudly here instead of surfacing as a black poster somewhere in the scene.
 */
export function parseCatalogue(input: unknown): Catalogue {
  const data = input as Partial<Catalogue> | null;
  if (!data?.atlas || !Array.isArray(data.films)) fail('missing atlas or films');
  const { atlas } = data;
  if (!isNumber(atlas.columns) || !isNumber(atlas.cellWidth) || !isNumber(atlas.cellHeight)) {
    fail('atlas geometry is incomplete');
  }
  data.films.forEach((film, i) => {
    if (typeof film.slug !== 'string' || typeof film.title !== 'string') fail(`film ${i} has no slug or title`);
    if (!isNumber(film.year) || !isNumber(film.minutes)) fail(`${film.slug} has no year or runtime`);
    if (!isNumber(film.image?.width) || !isNumber(film.image?.height)) fail(`${film.slug} has no image size`);
    if (film.light?.length !== LIGHT_COLUMNS * LIGHT_ROWS || !film.light.every((s) => s.length === 4 && s.every(isNumber))) {
      fail(`${film.slug} needs ${LIGHT_COLUMNS * LIGHT_ROWS} light samples of four numbers`);
    }
  });
  return data as Catalogue;
}

export const catalogue: Catalogue = parseCatalogue(raw);

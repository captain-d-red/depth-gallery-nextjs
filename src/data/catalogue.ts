import raw from './films.json';
import { LIGHT_COLUMNS, LIGHT_ROWS } from './light-grid';

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
  /**
   * The poster's most vivid colour and a second one, as sRGB hex. The accent equals the key
   * when the poster carries only one colour worth lighting a room with.
   */
  readonly palette: { readonly key: string; readonly accent: string };
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

export { LIGHT_COLUMNS, LIGHT_ROWS };

function fail(message: string): never {
  throw new Error(`films.json: ${message}`);
}

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isHex = (value: unknown): boolean => isString(value) && /^#[0-9a-f]{6}$/i.test(value);

function assertFilm(film: unknown, i: number): void {
  if (!isRecord(film) || !isString(film.slug) || !isString(film.title)) fail(`film ${i} has no slug or title`);
  const { slug } = film;
  if (!isNumber(film.year) || !isNumber(film.minutes)) fail(`${slug} has no year or runtime`);
  if (!isString(film.director) || !isString(film.logline) || !Array.isArray(film.genres))
    fail(`${slug} is missing credits`);
  if (
    !isRecord(film.image) ||
    !isString(film.image.src) ||
    !isNumber(film.image.width) ||
    !isNumber(film.image.height)
  ) {
    fail(`${slug} has no image`);
  }
  if (!isNumber(film.atlasIndex)) fail(`${slug} has no atlas cell`);
  const light: unknown = film.light;
  const samples = LIGHT_COLUMNS * LIGHT_ROWS;
  if (
    !Array.isArray(light) ||
    light.length !== samples ||
    !light.every((s) => Array.isArray(s) && s.length === 4 && s.every(isNumber))
  ) {
    fail(`${slug} needs ${samples} light samples of four numbers`);
  }
  if (!isRecord(film.palette) || !isHex(film.palette.key) || !isHex(film.palette.accent)) {
    fail(`${slug} has an incomplete palette`);
  }
}

/**
 * Checks the generated catalogue once at module load, so a broken build of the data
 * fails loudly here instead of surfacing as a black poster somewhere in the scene.
 */
export function assertCatalogue(input: unknown): asserts input is Catalogue {
  if (!isRecord(input) || !isRecord(input.atlas) || !Array.isArray(input.films)) fail('missing atlas or films');
  const { atlas } = input;
  if (!isString(atlas.src)) fail('atlas has no source');
  for (const key of ['columns', 'cellWidth', 'cellHeight', 'width', 'height']) {
    if (!isNumber(atlas[key])) fail(`atlas.${key} is not a number`);
  }
  input.films.forEach(assertFilm);
}

function parseCatalogue(input: unknown): Catalogue {
  assertCatalogue(input);
  return input;
}

export const catalogue: Catalogue = parseCatalogue(raw);

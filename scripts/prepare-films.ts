/**
 * Builds the film catalogue from the poster sources.
 *
 *   node scripts/prepare-films.ts [--src <dir>]
 *
 * The source folder holds one JPEG per film plus catalogue.json and trailers.meta.json.
 * The script writes 1024px WebP posters and a low-resolution atlas into public/films, and
 * writes src/data/films.json with metadata, each poster's vivid key and accent colours, and
 * the light samples that tint the haze around it.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp, { type OverlayOptions } from 'sharp';
import { LIGHT_COLUMNS, LIGHT_ROWS } from '../src/data/light-grid.ts';
import {
  type Oklch,
  type Vec3,
  linearSrgbToOklab,
  linearToHex,
  oklabToOklch,
  oklchToLinearSrgb,
  oklchToOklab,
  srgbToLinear,
} from '../src/lib/color.ts';
import { NEUTRAL_CHROMA, type VividPalette, familyMembership, vividPalette, vividWeight } from '../src/lib/palette.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argSrc = process.argv.indexOf('--src');
const srcDir = path.resolve(
  argSrc > 0 && process.argv[argSrc + 1]
    ? process.argv[argSrc + 1]!
    : path.join(root, '..', 'depth-gallery-nextjs-local-scripts', 'poster-src'),
);
const outDir = path.join(root, 'public', 'films');
const dataFile = path.join(root, 'src', 'data', 'films.json');

const POSTER_HEIGHT = 1024;
const ATLAS_COLUMNS = 12;
const CELL = { w: 64, h: 96 } as const;
/**
 * Analysis size. Small on purpose, so thin lettering averages into its background and the
 * palette follows the large areas of colour a viewer actually remembers.
 */
const SAMPLE = { w: 32, h: 48 } as const;

interface SourceTitle {
  slug: string;
  title: string;
  year: number;
  dir: string;
  min: number;
  genres: string[];
  line: string;
}

interface Pixel extends Oklch {
  readonly lab: Vec3;
}

function readPixels(buf: Buffer): Pixel[] {
  const out: Pixel[] = [];
  for (let i = 0; i < buf.length; i += 3) {
    const lab = linearSrgbToOklab([
      srgbToLinear(buf[i]! / 255),
      srgbToLinear(buf[i + 1]! / 255),
      srgbToLinear(buf[i + 2]! / 255),
    ]);
    out.push({ lab, ...oklabToOklch(lab) });
  }
  return out;
}

/**
 * The emitted colour of a family, pinned bright and saturated so it reads as light. A
 * monochrome poster emits a faintly warm white instead of an invented hue.
 */
function lightColour({ C, h }: Oklch): Oklch {
  if (C < NEUTRAL_CHROMA) return { L: 0.74, C: 0.022, h };
  return { L: 0.7, C: Math.min(0.2, Math.max(0.1, C * 1.3)), h };
}

/**
 * One light sample per region of the poster. Each region glows in the key or the accent,
 * whichever of the two it actually contains, and glows as brightly as that colour is present,
 * so the light comes from where the vivid colour sits on the print.
 */
function regionLights(pixels: Pixel[], palette: VividPalette): [number, number, number, number][] {
  const presence = (region: Pixel[], colour: Oklch) =>
    region.reduce((sum, p) => sum + vividWeight(p) * familyMembership(p, colour.h), 0);
  const regions: Pixel[][] = [];
  const rw = SAMPLE.w / LIGHT_COLUMNS;
  const rh = SAMPLE.h / LIGHT_ROWS;
  for (let ry = 0; ry < LIGHT_ROWS; ry++) {
    for (let rx = 0; rx < LIGHT_COLUMNS; rx++) {
      const region: Pixel[] = [];
      for (let y = ry * rh; y < (ry + 1) * rh; y++) {
        for (let x = rx * rw; x < (rx + 1) * rw; x++) region.push(pixels[y * SAMPLE.w + x]!);
      }
      regions.push(region);
    }
  }
  const key = lightColour(palette.key);
  const accent = palette.accent ? lightColour(palette.accent) : key;
  const votes = regions.map((r) => {
    const a = palette.accent ? presence(r, palette.accent) : 0;
    return { a, total: presence(r, palette.key) + a };
  });
  const peak = Math.max(...votes.map((v) => v.total), 1e-9);
  const round = (v: number) => Math.round(v * 1000) / 1000;
  const [k0, k1, k2] = oklchToOklab(key);
  const [a0, a1, a2] = oklchToOklab(accent);
  return votes.map(({ a, total }) => {
    const t = total > 0 ? a / total : 0;
    const lab: Vec3 = [k0 + (a0 - k0) * t, k1 + (a1 - k1) * t, k2 + (a2 - k2) * t];
    const rgb = oklchToLinearSrgb(oklabToOklch(lab));
    const strength = 0.22 + 0.78 * (total / peak) ** 0.6;
    return [round(rgb[0]), round(rgb[1]), round(rgb[2]), round(strength)];
  });
}

const hex = (colour: Oklch) => linearToHex(oklchToLinearSrgb(colour));

async function main() {
  const source = JSON.parse(await fs.readFile(path.join(srcDir, 'catalogue.json'), 'utf8')) as {
    titles: SourceTitle[];
  };
  const trailers = JSON.parse(await fs.readFile(path.join(srcDir, 'trailers.meta.json'), 'utf8')) as Record<
    string,
    { id: string; a: number }
  >;
  await fs.mkdir(outDir, { recursive: true });

  // Each poster is read once at analysis size, and its vivid palette decides both its light
  // and its place inside its year.
  const analysed = await Promise.all(
    source.titles.map(async (t) => {
      const raw = await sharp(path.join(srcDir, `${t.slug}.jpg`))
        .resize(SAMPLE.w, SAMPLE.h, { fit: 'fill', kernel: 'mitchell' })
        .removeAlpha()
        .raw()
        .toBuffer();
      const pixels = readPixels(raw);
      return { t, pixels, palette: vividPalette(pixels) };
    }),
  );
  // Time runs into the screen, so films are ordered by year. Inside a year they follow hue,
  // which lets the haze drift between neighbouring colours instead of jumping.
  analysed.sort((a, b) => a.t.year - b.t.year || a.palette.key.h - b.palette.key.h);

  const rows = Math.ceil(analysed.length / ATLAS_COLUMNS);
  const atlasTiles: OverlayOptions[] = [];
  const films = [];

  for (const [index, { t, pixels, palette }] of analysed.entries()) {
    const file = path.join(srcDir, `${t.slug}.jpg`);
    const poster = sharp(file).rotate();
    const out = await poster
      .clone()
      .resize({ height: POSTER_HEIGHT })
      .webp({ quality: 82, effort: 5 })
      .toBuffer({ resolveWithObject: true });
    await fs.writeFile(path.join(outDir, `${t.slug}.webp`), out.data);

    const cell = await sharp(file).resize(CELL.w, CELL.h, { fit: 'cover' }).toBuffer();
    atlasTiles.push({
      input: cell,
      left: (index % ATLAS_COLUMNS) * CELL.w,
      top: Math.floor(index / ATLAS_COLUMNS) * CELL.h,
    });

    const light = regionLights(pixels, palette);

    const trailer = trailers[t.slug];
    films.push({
      slug: t.slug,
      title: t.title,
      year: t.year,
      director: t.dir,
      minutes: t.min,
      genres: t.genres,
      logline: t.line,
      image: { src: `/films/${t.slug}.webp`, width: out.info.width, height: out.info.height },
      atlasIndex: index,
      light,
      palette: { key: hex(lightColour(palette.key)), accent: hex(lightColour(palette.accent ?? palette.key)) },
      trailer: trailer ? { id: trailer.id, aspect: trailer.a } : null,
    });
  }

  const atlas = {
    src: '/films/atlas.webp',
    columns: ATLAS_COLUMNS,
    cellWidth: CELL.w,
    cellHeight: CELL.h,
    width: ATLAS_COLUMNS * CELL.w,
    height: rows * CELL.h,
  };
  await sharp({ create: { width: atlas.width, height: atlas.height, channels: 3, background: '#000000' } })
    .composite(atlasTiles)
    .webp({ quality: 74 })
    .toFile(path.join(outDir, 'atlas.webp'));

  await fs.writeFile(dataFile, `${JSON.stringify({ atlas, films }, null, 2)}\n`);
  const bytes = (await Promise.all((await fs.readdir(outDir)).map((f) => fs.stat(path.join(outDir, f))))).reduce(
    (s, st) => s + st.size,
    0,
  );
  console.log(
    `${films.length} films, ${(bytes / 1048576).toFixed(1)} MB of images, catalogue at ${path.relative(root, dataFile)}`,
  );
}

await main();

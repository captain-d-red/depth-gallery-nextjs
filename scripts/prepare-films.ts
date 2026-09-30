/**
 * Builds the film catalogue from the poster sources.
 *
 *   node scripts/prepare-films.ts [--src <dir>]
 *
 * The source folder holds one JPEG per film plus catalogue.json and trailers.meta.json.
 * The script writes 1024px WebP posters and a low-resolution atlas into public/films, and
 * writes src/data/films.json with metadata, grade colours and the light samples that tint
 * the haze around each poster.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  type Vec3,
  linearSrgbToOklab,
  linearToHex,
  oklabToOklch,
  oklchToLinearSrgb,
  srgbToLinear,
} from '../src/lib/color.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argSrc = process.argv.indexOf('--src');
const srcDir = path.resolve(
  argSrc > 0 && process.argv[argSrc + 1] ? process.argv[argSrc + 1]! : path.join(root, '..', 'depth-gallery-nextjs-local-scripts', 'poster-src'),
);
const outDir = path.join(root, 'public', 'films');
const dataFile = path.join(root, 'src', 'data', 'films.json');

const POSTER_HEIGHT = 1024;
const ATLAS_COLUMNS = 12;
const CELL = { w: 64, h: 96 } as const;
const SAMPLE = { w: 48, h: 72 } as const;

interface SourceTitle {
  slug: string;
  title: string;
  year: number;
  dir: string;
  min: number;
  genres: string[];
  line: string;
  dom: [number, number, number];
  acc: [number, number, number];
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Skin sits near a hue of 40 to 70 degrees at modest chroma, and it must not set the light. */
function skinWeight(C: number, h: number): number {
  const deg = (h * 180) / Math.PI;
  const inHue = deg > 25 && deg < 80 ? 1 : 0;
  return inHue && C < 0.11 ? 0.25 : 1;
}

interface Pixel {
  lab: Vec3;
  L: number;
  C: number;
  h: number;
}

function readPixels(buf: Buffer): Pixel[] {
  const out: Pixel[] = [];
  for (let i = 0; i < buf.length; i += 3) {
    const lab = linearSrgbToOklab([srgbToLinear(buf[i]! / 255), srgbToLinear(buf[i + 1]! / 255), srgbToLinear(buf[i + 2]! / 255)]);
    const { L, C, h } = oklabToOklch(lab);
    out.push({ lab, L, C, h });
  }
  return out;
}

/**
 * One light sample per region. The hue is a chroma-weighted mean in OKLab, so vivid pixels
 * decide it, and the emitted colour is pinned to one lightness so a dark poster still lights
 * the air in its own hue. Strength follows how bright the region really is.
 */
function regionLight(pixels: Pixel[], fallbackHue: number): [number, number, number, number] {
  let wa = 0;
  let wb = 0;
  let wsum = 0;
  let lsum = 0;
  let csum = 0;
  for (const p of pixels) {
    const w = p.C ** 1.4 * smoothstep(0.1, 0.32, p.L) * skinWeight(p.C, p.h);
    wa += p.lab[1] * w;
    wb += p.lab[2] * w;
    wsum += w;
    csum += p.C;
    lsum += p.L;
  }
  const meanL = lsum / pixels.length;
  const meanC = csum / pixels.length;
  const hue = wsum > 1e-6 ? Math.atan2(wb, wa) : fallbackHue;
  const chroma = Math.min(0.19, Math.max(0.035, meanC * 1.6));
  const rgb = oklchToLinearSrgb({ L: 0.64, C: chroma, h: hue < 0 ? hue + Math.PI * 2 : hue });
  const strength = 0.3 + 0.7 * smoothstep(0.12, 0.62, meanL);
  const round = (v: number) => Math.round(v * 1000) / 1000;
  return [round(rgb[0]), round(rgb[1]), round(rgb[2]), round(strength)];
}

function shadeTone(pixels: Pixel[]): string {
  const sorted = [...pixels].sort((a, b) => a.L - b.L);
  const dark = sorted.slice(0, Math.max(1, Math.floor(sorted.length * 0.3)));
  const mean = dark.reduce<[number, number, number]>((acc, p) => [acc[0] + p.lab[0], acc[1] + p.lab[1], acc[2] + p.lab[2]], [0, 0, 0]);
  const lch = oklabToOklch([mean[0] / dark.length, mean[1] / dark.length, mean[2] / dark.length]);
  return linearToHex(oklchToLinearSrgb({ L: Math.min(0.3, Math.max(0.16, lch.L)), C: Math.min(0.07, lch.C), h: lch.h }));
}

function hexFromSrgb8([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

async function main() {
  const source = JSON.parse(await fs.readFile(path.join(srcDir, 'catalogue.json'), 'utf8')) as { titles: SourceTitle[] };
  const trailers = JSON.parse(await fs.readFile(path.join(srcDir, 'trailers.meta.json'), 'utf8')) as Record<string, { id: string; a: number }>;
  await fs.mkdir(outDir, { recursive: true });

  const titles = [...source.titles];
  const keyHue = ({ dom: [r, g, b] }: SourceTitle) =>
    oklabToOklch(linearSrgbToOklab([srgbToLinear(r / 255), srgbToLinear(g / 255), srgbToLinear(b / 255)])).h;
  // Time runs into the screen, so films are ordered by year. Inside a year they follow hue,
  // which lets the haze drift between neighbouring colours instead of jumping.
  titles.sort((a, b) => a.year - b.year || keyHue(a) - keyHue(b));

  const rows = Math.ceil(titles.length / ATLAS_COLUMNS);
  const atlasTiles: sharp.OverlayOptions[] = [];
  const films = [];

  for (const [index, t] of titles.entries()) {
    const file = path.join(srcDir, `${t.slug}.jpg`);
    const poster = sharp(file).rotate();
    const out = await poster.clone().resize({ height: POSTER_HEIGHT }).webp({ quality: 82, effort: 5 }).toBuffer({ resolveWithObject: true });
    await fs.writeFile(path.join(outDir, `${t.slug}.webp`), out.data);

    const cell = await sharp(file).resize(CELL.w, CELL.h, { fit: 'cover' }).toBuffer();
    atlasTiles.push({ input: cell, left: (index % ATLAS_COLUMNS) * CELL.w, top: Math.floor(index / ATLAS_COLUMNS) * CELL.h });

    const sample = await sharp(file).resize(SAMPLE.w, SAMPLE.h, { fit: 'fill' }).removeAlpha().raw().toBuffer();
    const pixels = readPixels(sample);
    const hue = keyHue(t);
    const light: [number, number, number, number][] = [];
    const rw = SAMPLE.w / 2;
    const rh = SAMPLE.h / 3;
    for (let ry = 0; ry < 3; ry++) {
      for (let rx = 0; rx < 2; rx++) {
        const region: Pixel[] = [];
        for (let y = ry * rh; y < (ry + 1) * rh; y++) {
          for (let x = rx * rw; x < (rx + 1) * rw; x++) region.push(pixels[y * SAMPLE.w + x]!);
        }
        light.push(regionLight(region, hue));
      }
    }

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
      palette: { key: hexFromSrgb8(t.dom), fill: hexFromSrgb8(t.acc), shade: shadeTone(pixels) },
      trailer: trailer ? { id: trailer.id, aspect: trailer.a } : null,
    });
  }

  const atlas = { src: '/films/atlas.webp', columns: ATLAS_COLUMNS, cellWidth: CELL.w, cellHeight: CELL.h, width: ATLAS_COLUMNS * CELL.w, height: rows * CELL.h };
  await sharp({ create: { width: atlas.width, height: atlas.height, channels: 3, background: '#000000' } })
    .composite(atlasTiles)
    .webp({ quality: 74 })
    .toFile(path.join(outDir, 'atlas.webp'));

  await fs.writeFile(dataFile, `${JSON.stringify({ atlas, films }, null, 2)}\n`);
  const bytes = (await Promise.all((await fs.readdir(outDir)).map((f) => fs.stat(path.join(outDir, f))))).reduce((s, st) => s + st.size, 0);
  console.log(`${films.length} films, ${(bytes / 1048576).toFixed(1)} MB of images, catalogue at ${path.relative(root, dataFile)}`);
}

await main();

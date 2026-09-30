/**
 * Lays every poster beside its chosen key and accent colours in one contact sheet, so the
 * palette picks can be judged by eye in a single image. Writes tools/shots/palette.png.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { films } = JSON.parse(await fs.readFile(path.join(root, 'src/data/films.json'), 'utf8'));
const COLS = 12;
const W = 120;
const H = 180;
const STRIP = 26;
const rows = Math.ceil(films.length / COLS);
const tiles = await Promise.all(
  films.map(async (film, i) => {
    const poster = await sharp(path.join(root, 'public', film.image.src))
      .resize(W, H, { fit: 'cover' })
      .toBuffer();
    const swatch = Buffer.from(
      `<svg width="${W}" height="${STRIP}"><rect width="${W / 2}" height="${STRIP}" fill="${film.palette.key}"/><rect x="${W / 2}" width="${W / 2}" height="${STRIP}" fill="${film.palette.accent}"/></svg>`,
    );
    const left = (i % COLS) * W;
    const top = Math.floor(i / COLS) * (H + STRIP);
    return [
      { input: poster, left, top },
      { input: swatch, left, top: top + H },
    ];
  }),
);
const out = path.join(root, 'tools', 'shots', 'palette.png');
await fs.mkdir(path.dirname(out), { recursive: true });
await sharp({ create: { width: COLS * W, height: rows * (H + STRIP), channels: 3, background: '#000' } })
  .composite(tiles.flat())
  .png()
  .toFile(out);
console.log(out);

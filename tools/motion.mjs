/**
 * Records the scene while it moves. Scrolls with real wheel input at a steady rate and grabs a
 * frame at a fixed interval, then lays the frames out in one sheet, tools/shots/motion.png.
 *
 *   node tools/motion.mjs [url] [--from 0] [--frames 12] [--interval 110] [--delta 90]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import sharp from 'sharp';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const url = args.find((a) => a.startsWith('http')) ?? 'http://localhost:3100';
const from = Number(flag('from', '0'));
const frames = Number(flag('frames', '12'));
const interval = Number(flag('interval', '110'));
const delta = Number(flag('delta', '90'));
const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shots');
await fs.mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(3800);
await page.mouse.move(760, 420);
for (let i = 0; i < Math.round(from); i++) {
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(1300);
}
await page.waitForTimeout(1200);
const shots = [];
for (let f = 0; f < frames; f++) {
  await page.mouse.wheel(0, delta);
  await page.waitForTimeout(interval);
  shots.push(await page.screenshot());
}
await browser.close();
const W = 480;
const H = 300;
const cols = 4;
const tiles = await Promise.all(shots.map((s) => sharp(s).resize(W, H).toBuffer()));
const out = path.join(outDir, 'motion.png');
await sharp({ create: { width: cols * W, height: Math.ceil(frames / cols) * H, channels: 3, background: '#000' } })
  .composite(tiles.map((input, i) => ({ input, left: (i % cols) * W, top: Math.floor(i / cols) * H })))
  .png()
  .toFile(out);
console.log(out);

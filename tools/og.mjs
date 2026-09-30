/**
 * Renders the link-preview image from the live scene, framed on a film, into
 * src/app/opengraph-image.jpg at the 1200 by 630 size social platforms expect.
 *
 *   node tools/og.mjs [url] [--film 2]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import sharp from 'sharp';

const args = process.argv.slice(2);
const url = args.find((a) => a.startsWith('http')) ?? 'http://localhost:3100';
const filmArg = args.indexOf('--film');
const film = filmArg >= 0 ? Number(args[filmArg + 1]) : 2;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 2 });
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(3600);
for (let i = 0; i < film; i++) {
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(1500);
}
await page.waitForTimeout(1800);
const shot = await page.screenshot();
await browser.close();
const out = path.join(root, 'src', 'app', 'opengraph-image.jpg');
await sharp(shot).resize(1200, 630).jpeg({ quality: 86, mozjpeg: true }).toFile(out);
console.log(out);

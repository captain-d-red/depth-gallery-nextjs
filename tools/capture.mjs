/**
 * Renders the site in the installed Chrome with a real GPU and real input, and saves one
 * screenshot per viewport and scroll stop into tools/shots.
 *
 *   node tools/capture.mjs [url] [--stops 0,1,2.5] [--sizes laptop,fhd] [--hover 0.6,0.45]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const SIZES = {
  laptop: { width: 1440, height: 900, deviceScaleFactor: 2 },
  fhd: { width: 1920, height: 1080, deviceScaleFactor: 1 },
  imac: { width: 2560, height: 1440, deviceScaleFactor: 2 },
  uhd: { width: 3840, height: 2160, deviceScaleFactor: 1 },
  mbp14: { width: 1512, height: 982, deviceScaleFactor: 2 },
  mbp16: { width: 1728, height: 1117, deviceScaleFactor: 2 },
  win: { width: 1366, height: 768, deviceScaleFactor: 1 },
  ultrawide: { width: 2560, height: 1080, deviceScaleFactor: 1 },
  tablet: { width: 1180, height: 820, deviceScaleFactor: 2 },
  tabletPortrait: { width: 820, height: 1180, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  phone: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  android: { width: 412, height: 915, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true },
  phoneSmall: { width: 375, height: 667, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  phoneLandscape: { width: 844, height: 390, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
};

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const url = args.find((a) => a.startsWith('http')) ?? 'http://localhost:3100';
const stops = flag('stops', '0,0.5,1,3').split(',').map(Number);
const sizes = flag('sizes', 'laptop').split(',');
const settle = Number(flag('settle', '1800'));
/** Optional pointer position, as fractions of the viewport, for a hover capture at each stop. */
const hover = flag('hover', '') ? flag('hover', '').split(',').map(Number) : null;
/** Matches the wheel multiplier the page gives its smooth scroller. */
const WHEEL_SCALE = 0.85;
const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shots');
await fs.mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'],
});

for (const name of sizes) {
  const size = SIZES[name];
  if (!size) throw new Error(`Unknown size ${name}, expected one of ${Object.keys(SIZES).join(', ')}`);
  const { width, height, ...rest } = size;
  const page = await browser.newPage({ viewport: { width, height }, ...rest });
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && problems.push(`console ${m.text()}`));
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3800);
  await page.mouse.move(width * 0.52, height * 0.46);

  for (const stop of stops) {
    // Each stop is a film position, reached with real wheel input like a visitor would.
    const target = await page.evaluate((s) => {
      const limit = document.documentElement.scrollHeight - window.innerHeight;
      return Math.round((s / 71) * limit);
    }, stop);
    // Smooth scrolling scales and delays wheel input, so correct against the real offset.
    for (let pass = 0; pass < 5; pass++) {
      const current = await page.evaluate(() => window.scrollY);
      let remaining = (target - current) / WHEEL_SCALE;
      if (Math.abs(target - current) <= 3) break;
      while (Math.abs(remaining) > 0.5) {
        const delta = Math.max(-240, Math.min(240, remaining));
        await page.mouse.wheel(0, delta);
        await page.waitForTimeout(30);
        remaining -= delta;
      }
      await page.waitForTimeout(1400);
    }
    await page.waitForTimeout(settle);
    const file = path.join(outDir, `${name}-${String(stop).replace('.', '_')}.png`);
    await page.screenshot({ path: file });
    console.log(file);
    if (hover) {
      await page.mouse.move(width * hover[0], height * hover[1], { steps: 12 });
      await page.waitForTimeout(900);
      await page.screenshot({ path: file.replace('.png', '-hover.png') });
      await page.mouse.move(width * 0.52, height * 0.46, { steps: 6 });
    }
  }
  const fps = await page.evaluate(
    () =>
      new Promise((resolve) => {
        let n = 0;
        const t0 = performance.now();
        const step = () => (++n < 120 ? requestAnimationFrame(step) : resolve((n * 1000) / (performance.now() - t0)));
        requestAnimationFrame(step);
      }),
  );
  console.log(`${name} ${Math.round(fps)} fps`, problems.length ? problems : 'no errors');
  await page.close();
}
await browser.close();

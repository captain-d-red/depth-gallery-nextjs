import { chromium } from '@playwright/test';
const b = await chromium.launch({ channel: 'chrome', args: ['--use-angle=d3d11','--enable-gpu','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1200, height: 800 } });
p.on('console', (m) => console.log('console', m.type(), m.text().slice(0, 600)));
await p.goto('http://localhost:3100', { waitUntil: 'networkidle' });
await p.waitForTimeout(3500);
for (let i = 0; i < 8; i++) { await p.mouse.wheel(0, 50); await p.waitForTimeout(80); }
await p.waitForTimeout(1200);
const out = await p.evaluate(() => {
  const r = globalThis.__renderer;
  return { calls: r.info.render.calls, programs: r.info.programs.map((pr) => ({ name: pr.name, diag: pr.diagnostics ? JSON.stringify(pr.diagnostics).slice(0, 900) : null })) };
});
console.log(JSON.stringify(out, null, 1).slice(0, 4000));
await b.close();

/**
 * Fast UI check in Flat 2D mode (no WebGL): phone + desktop layouts, overflow, forms.
 *   npx vite build && npx tsx scripts/ui-check.ts <outDir>
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';
const OUT = process.argv[2];
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer((req, res) => {
  const path = join('dist', decodeURIComponent((req.url ?? '/').split('?')[0]));
  const file = existsSync(path) && !path.endsWith('/') ? path : join('dist', 'index.html');
  res.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream');
  res.end(readFileSync(file));
});
server.listen(0, async () => {
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    args: [
      ...(process.env.HTTPS_PROXY ? [`--proxy-server=${process.env.HTTPS_PROXY}`, '--proxy-bypass-list=127.0.0.1;localhost'] : []),
      ...(process.env.PROXY_CA_SPKI ? [`--ignore-certificate-errors-spki-list=${process.env.PROXY_CA_SPKI}`] : []),
    ],
  });
  for (const vp of [{ width: 400, height: 820 }, { width: 1280, height: 800 }]) {
    const page = await browser.newPage({ viewport: vp });
    await page.addInitScript(() => localStorage.setItem('gitgud.save.v1', JSON.stringify({ version: 1, identity: null, completed: {}, settings: { quality: 'flat', volume: 0, muted: true, showHud: true, reduceMotion: false, fontScale: 1 } })));
    await page.goto(url);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${OUT}/flat-title-${vp.width}.png` });
    console.log(vp.width, 'overflow:', await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth));
    await page.evaluate(() => (window as any).gitgud.startLevel(11));
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${OUT}/flat-level-${vp.width}.png` });
    await page.keyboard.type('git push');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);
    const stamp = await page.evaluate(() => {
      const el = document.querySelector('.stamp.red') as HTMLElement;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return { opacity: cs.opacity, display: cs.display, rect: [r.x, r.y, r.width, r.height], text: el.textContent };
    });
    console.log('stamp', JSON.stringify(stamp));
    await page.screenshot({ path: `${OUT}/flat-incident-${vp.width}.png` });
    await page.close();
  }
  await browser.close();
  server.close();
});

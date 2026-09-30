/**
 * Regression check for camera views: the Lean back / Pingr buttons toggle back to
 * the terminal, F3 toggles, and clicking a monitor looks at it.
 *   npx vite build && npx tsx scripts/view-check.ts
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer((req, res) => {
  const path = join('dist', decodeURIComponent((req.url ?? '/').split('?')[0]));
  const file = existsSync(path) && !path.endsWith('/') ? path : join('dist', 'index.html');
  res.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream');
  res.end(readFileSync(file));
});

type G = { gitgud: { startLevel(i: number): Promise<void>; renderer: { focus: string; snapCamera(): void } } };
const focus = (page: Page) => page.evaluate(() => (window as unknown as G).gitgud.renderer.focus);
const pressed = (page: Page) =>
  page.evaluate(() => ['terminal', 'chat', 'overview'].filter((v) => document.getElementById(`view-${v}`)!.getAttribute('aria-pressed') === 'true'));

let failures = 0;
function expect(label: string, actual: unknown, wanted: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(wanted);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (wanted ${JSON.stringify(wanted)})`}`);
}

server.listen(0, async () => {
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(() =>
    localStorage.setItem('gitgud.save.v1', JSON.stringify({ version: 1, identity: null, completed: {}, settings: { quality: 'low', volume: 0, muted: true, showHud: false, reduceMotion: true, fontScale: 1 } })),
  );
  await page.goto(url);
  await page.waitForTimeout(3000);
  await page.evaluate(() => (window as unknown as G).gitgud.startLevel(1));
  await page.waitForTimeout(2500);
  expect('starts on terminal', await focus(page), 'terminal');

  await page.click('#view-overview');
  expect('Lean back leans back', [await focus(page), await pressed(page)], ['overview', ['overview']]);
  await page.click('#view-overview');
  expect('Lean back again returns', [await focus(page), await pressed(page)], ['terminal', ['terminal']]);

  await page.click('#view-chat');
  expect('Pingr looks at chat', await focus(page), 'chat');
  await page.click('#view-chat');
  expect('Pingr again returns', await focus(page), 'terminal');

  await page.keyboard.press('F3');
  expect('F3 leans back', await focus(page), 'overview');
  await page.keyboard.press('F3');
  expect('F3 again returns', await focus(page), 'terminal');

  // Lean back, let the camera arrive, then click the middle monitor.
  await page.click('#view-overview');
  await page.evaluate(() => (window as unknown as G).gitgud.renderer.snapCamera());
  await page.waitForTimeout(800);
  await page.mouse.click(760, 330);
  expect('clicking the terminal monitor looks at it', await focus(page), 'terminal');

  console.log(failures ? `${failures} FAILED` : 'all view checks passed');
  await browser.close();
  server.close();
  process.exit(failures ? 1 : 0);
});

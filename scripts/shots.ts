/**
 * Visual check: jumps straight to interesting moments and screenshots them.
 *   npx vite build && npx tsx scripts/shots.ts [outDir]
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const out = process.argv[2] ?? 'screenshots';
const only = process.argv[3];
mkdirSync(out, { recursive: true });
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

function serve(dir: string): Promise<{ url: string; close: () => void }> {
  const server = createServer((req, res) => {
    const path = join(dir, decodeURIComponent((req.url ?? '/').split('?')[0]));
    const file = existsSync(path) && !path.endsWith('/') ? path : join(dir, 'index.html');
    res.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream');
    res.end(readFileSync(file));
  });
  return new Promise((r) => server.listen(0, () => r({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`, close: () => server.close() })));
}

type G = { gitgud: { startLevel(i: number): Promise<void>; renderer: { setFocus(f: string): void; snapCamera(): void } | null } };

async function level(page: Page, i: number) {
  await page.evaluate((n) => (window as unknown as G).gitgud.startLevel(n), i);
  await page.waitForTimeout(2600);
}

async function run(page: Page, cmds: string[]) {
  for (const c of cmds) {
    await page.keyboard.type(c, { delay: 2 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
  }
}

async function focus(page: Page, f: string) {
  await page.evaluate((x) => {
    const g = (window as unknown as G).gitgud;
    g.renderer?.setFocus(x);
    g.renderer?.snapCamera();
  }, f);
  await page.waitForTimeout(900);
}

async function main() {
  const { url, close } = await serve('dist');
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
    args: [
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      ...(process.env.HTTPS_PROXY ? [`--proxy-server=${process.env.HTTPS_PROXY}`, '--proxy-bypass-list=127.0.0.1;localhost'] : []),
      // Trust exactly the sandbox proxy's CA (by public-key hash) when one is configured.
      ...(process.env.PROXY_CA_SPKI ? [`--ignore-certificate-errors-spki-list=${process.env.PROXY_CA_SPKI}`] : []),
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
  await page.goto(url);
  await page.waitForTimeout(3500);
  const want = (name: string) => !only || only.split(',').includes(name);

  if (want('title')) await page.screenshot({ path: `${out}/title.png` });

  if (want('conflict')) {
    await level(page, 4); // merge conflict
    await run(page, ['git fetch', 'git merge origin/main']);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${out}/conflict-terminal.png` });
    await run(page, ['nano config.yml']);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${out}/conflict-nano.png` });
    await page.keyboard.press('Control+x');
    await focus(page, 'chat');
    await page.screenshot({ path: `${out}/chat.png` });
    await focus(page, 'overview');
    await page.screenshot({ path: `${out}/overview-afternoon.png` });
  }
  if (want('night')) {
    await level(page, 13); // Friday 4:47 PM
    await run(page, ['git status']);
    await focus(page, 'overview');
    await page.screenshot({ path: `${out}/overview-evening.png` });
    await focus(page, 'terminal');
    await page.screenshot({ path: `${out}/finale-terminal.png` });
  }
  if (want('graph')) {
    await level(page, 7); // cherry-pick
    await run(page, ['git log --oneline --graph --all', 'git branch -a']);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${out}/graph.png` });
  }

  if (want('menus')) {
    await page.evaluate(() => (document.getElementById('btn-levels') as HTMLButtonElement).click());
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${out}/levels.png` });
    await level(page, 11); // secrets
    await run(page, ['git push']);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${out}/incident.png` });
  }
  if (want('phone')) {
    const phone = await browser.newPage({ viewport: { width: 400, height: 820 }, isMobile: true, hasTouch: true });
    await phone.goto(url);
    await phone.waitForTimeout(4000);
    await phone.screenshot({ path: `${out}/phone-title.png` });
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    console.log('phone horizontal overflow:', overflow);
    await phone.close();
  }

  console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no page errors');
  await browser.close();
  close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

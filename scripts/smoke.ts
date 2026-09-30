/**
 * Browser smoke test: serves the production build, drives the game in headless
 * Chromium (software WebGL), and saves screenshots. Usage:
 *
 *   npx vite build && npx tsx scripts/smoke.ts [outDir]
 *
 * Needs a Chromium binary (CHROMIUM_PATH, default /opt/pw-browsers/chromium).
 */
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const out = process.argv[2] ?? 'screenshots';
mkdirSync(out, { recursive: true });

const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

function serve(dir: string): Promise<{ url: string; close: () => void }> {
  const server = createServer((req, res) => {
    const path = join(dir, decodeURIComponent((req.url ?? '/').split('?')[0]));
    const file = existsSync(path) && !path.endsWith('/') ? path : join(dir, 'index.html');
    res.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream');
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`, close: () => server.close() })));
}

async function typeCommand(page: Page, cmd: string) {
  await page.keyboard.type(cmd, { delay: 5 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
}

async function main() {
  const { url, close } = await serve('dist');
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
    args: [
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      // Only external requests (Google Fonts) go through the proxy; the local server is direct.
      ...(process.env.HTTPS_PROXY ? [`--proxy-server=${process.env.HTTPS_PROXY}`, '--proxy-bypass-list=127.0.0.1;localhost'] : []),
      // Trust exactly the sandbox proxy's CA (by public-key hash) when one is configured.
      ...(process.env.PROXY_CA_SPKI ? [`--ignore-certificate-errors-spki-list=${process.env.PROXY_CA_SPKI}`] : []),
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });

  await page.goto(url);
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${out}/01-title.png` });

  await page.click('#btn-start');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${out}/02-curtain.png` });
  await page.waitForTimeout(5000);
  await page.screenshot({ path: `${out}/03-level1-start.png` });

  await typeCommand(page, 'git config --global user.name "Pat Example"');
  await typeCommand(page, 'git config --global user.email pat@conglomo.com');
  await typeCommand(page, 'git clone git@github.com:conglomo/onboarding.git');
  await typeCommand(page, 'cd onboarding');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/04-level1-mid.png` });
  await page.click('#view-chat');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${out}/05-chat.png` });
  await page.click('#view-terminal');
  await page.waitForTimeout(1500);
  await typeCommand(page, 'cat README.md');
  await page.waitForTimeout(9000);
  await page.screenshot({ path: `${out}/06-review.png` });

  // Level 2 with nano, via the review form's Next button.
  await page.click('#btn-next');
  await page.waitForTimeout(3500);
  await typeCommand(page, 'git status');
  await typeCommand(page, 'nano index.html');
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/07-nano.png` });
  await page.keyboard.press('Control+x');
  await page.waitForTimeout(300);
  await typeCommand(page, 'git log --oneline --graph --all');
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}/08-level2.png` });
  await page.click('#view-overview');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${out}/09-overview.png` });

  const state = await page.evaluate(() => (window as unknown as { gitgud: { debugState(): unknown } }).gitgud.debugState());
  console.log(JSON.stringify(state, null, 2));
  console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no page errors');
  await browser.close();
  close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

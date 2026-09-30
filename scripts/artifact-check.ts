/**
 * Boots the single-file artifact build (wrapped in a minimal page skeleton) in
 * flat mode and plays a few commands, to prove the inlined bundle works.
 *   npx tsx scripts/artifact-check.ts <dir-with-index.html> <outDir>
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const [dir, out] = process.argv.slice(2);
const server = createServer((_req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(readFileSync(join(dir, 'index.html')));
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.addInitScript(() => localStorage.setItem('gitgud.save.v1', JSON.stringify({ version: 1, identity: null, completed: {}, settings: { quality: 'flat', volume: 0, muted: true, showHud: true, reduceMotion: true, fontScale: 1 } })));
  await page.goto(url);
  await page.waitForTimeout(2500);
  console.log('title:', await page.title());
  await page.click('#btn-start');
  await page.waitForTimeout(2500);
  for (const c of ['git config --global user.name "Pat"', 'git config --global user.email pat@x.com', 'git clone git@github.com:conglomo/onboarding.git', 'cd onboarding', 'cat README.md']) {
    await page.keyboard.type(c);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
  }
  await page.waitForTimeout(14000); // coworkers' wrap-up messages, then the review form
  const state = await page.evaluate(() => (window as unknown as { gitgud: { debugState(): { state: string } } }).gitgud.debugState().state);
  console.log('state after level 1:', state);
  const stamp = await page.evaluate(() => {
    const el = document.getElementById('review-stamp')!;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { text: el.textContent, rect: [r.x, r.y, r.width, r.height].map(Math.round), opacity: cs.opacity, z: cs.zIndex, topmost: top?.id || top?.className };
  });
  console.log('review stamp:', JSON.stringify(stamp));
  await page.screenshot({ path: join(out, 'artifact.png') });
  console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no page errors');
  await browser.close();
  server.close();
});

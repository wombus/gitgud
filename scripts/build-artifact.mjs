/**
 * Turns the Vite build (dist/) into one self-contained HTML fragment with the CSS
 * and JS inlined: easy to host anywhere that serves a single page (e.g. a
 * claude.ai Artifact, which wraps the fragment in its own <html>/<head>/<body>).
 *
 *   npm run build && node scripts/build-artifact.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dist = 'dist';
const html = readFileSync(join(dist, 'index.html'), 'utf8');

const cssHref = /<link rel="stylesheet" crossorigin href="\.\/(assets\/[^"]+\.css)">/.exec(html)?.[1];
const jsSrc = /<script type="module" crossorigin src="\.\/(assets\/[^"]+\.js)"><\/script>/.exec(html)?.[1];
if (!cssHref || !jsSrc) throw new Error('could not find built CSS/JS in dist/index.html');

const css = readFileSync(join(dist, cssHref), 'utf8');
let js = readFileSync(join(dist, jsSrc), 'utf8');
// A literal "</script" inside the bundle would end the inline <script> early.
js = js.replace(/<\/script/gi, '<\\/script');

const head = /<head>([\s\S]*?)<\/head>/.exec(html)[1];
const fonts = [...head.matchAll(/<link\s+rel="(?:preconnect|stylesheet)"[^>]*>/g)]
  .map((m) => m[0])
  .filter((l) => l.includes('fonts.g'))
  .join('\n');
const body = /<body>([\s\S]*?)<\/body>/.exec(html)[1].replace(/<script[\s\S]*?<\/script>/g, '').trim();

const out = `<title>GitGud</title>
${fonts}
<style>
${css}
</style>
${body}
<script type="module">
${js}
</script>
`;

mkdirSync('dist-artifact', { recursive: true });
writeFileSync('dist-artifact/gitgud.html', out);
console.log(`dist-artifact/gitgud.html: ${(out.length / 1024).toFixed(0)} KiB`);

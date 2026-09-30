import './ui/styles.css';
import { App } from './app';

/** Canvas text needs its fonts loaded *before* the first draw, or it silently falls back. */
async function loadFonts(): Promise<void> {
  if (!('fonts' in document)) return;
  const faces = [
    '400 25px "IBM Plex Mono"',
    '700 25px "IBM Plex Mono"',
    '400 24px "IBM Plex Sans"',
    '600 24px "IBM Plex Sans"',
    '700 24px "IBM Plex Sans"',
    '700 40px "Caveat"',
    '700 30px "IBM Plex Mono"',
  ];
  const timeout = new Promise<void>((r) => setTimeout(r, 3000));
  await Promise.race([Promise.all(faces.map((f) => document.fonts.load(f).catch(() => []))).then(() => undefined), timeout]);
}

async function boot() {
  await loadFonts();
  const app = new App();
  (window as unknown as { gitgud: App }).gitgud = app;
  await app.init();
}

void boot();

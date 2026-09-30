/**
 * Progress lives in localStorage. Every access is wrapped: storage can be
 * unavailable (private windows, blocked cookies, sandboxed previews) and the
 * game must still work, just without remembering anything.
 */

export interface Settings {
  /** 'flat' = no 3D office: the two screens side by side. */
  quality: 'low' | 'medium' | 'high' | 'flat';
  volume: number;
  muted: boolean;
  showHud: boolean;
  reduceMotion: boolean;
  fontScale: number;
}

export interface SaveData {
  version: 1;
  identity: { name: string; email: string } | null;
  completed: Record<string, { stars: number; rating: string }>;
  settings: Settings;
}

const KEY = 'gitgud.save.v1';

export const DEFAULT_SETTINGS: Settings = {
  quality: 'high',
  volume: 0.7,
  muted: false,
  showHud: true,
  reduceMotion: false,
  fontScale: 1,
};

function defaultSettings(): Settings {
  // Phones and tablets get a lighter default; they can opt back into High.
  let coarse = false;
  try {
    coarse = window.matchMedia('(pointer: coarse)').matches;
  } catch {
    coarse = false;
  }
  return { ...DEFAULT_SETTINGS, quality: coarse ? 'low' : 'high' };
}

export function loadSave(): SaveData {
  const fresh: SaveData = { version: 1, identity: null, completed: {}, settings: defaultSettings() };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fresh;
    const data = JSON.parse(raw) as SaveData;
    if (data.version !== 1) return fresh;
    return { ...fresh, ...data, settings: { ...fresh.settings, ...data.settings } };
  } catch {
    return fresh;
  }
}

export function writeSave(data: SaveData): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    // Storage unavailable: progress just won't persist.
  }
}

export function resetSave(): SaveData {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
  return loadSave();
}

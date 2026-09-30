/**
 * Tiny ANSI color helpers. The engine emits real ANSI SGR escape codes (just like
 * git does in a color terminal); the in-game terminal renderer parses them back
 * into colored spans. Keeping ANSI as the interchange format means engine output
 * can also be printed in a real terminal while debugging.
 */
const wrap = (code: string) => (s: string) => `\x1b[${code}m${s}\x1b[0m`;

export const c = {
  bold: wrap('1'),
  dim: wrap('2'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  magenta: wrap('35'),
  cyan: wrap('36'),
  white: wrap('37'),
  gray: wrap('90'),
  brightRed: wrap('91'),
  brightGreen: wrap('92'),
  brightYellow: wrap('93'),
  brightBlue: wrap('94'),
  brightMagenta: wrap('95'),
  brightCyan: wrap('96'),
  boldRed: wrap('1;31'),
  boldGreen: wrap('1;32'),
  boldYellow: wrap('1;33'),
  boldBlue: wrap('1;34'),
  boldCyan: wrap('1;36'),
  boldMagenta: wrap('1;35'),
};

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/**
 * The terminal's state, independent of how it's drawn: scrollback, the line being
 * edited, history navigation, and scroll position. Keeping this pure makes it easy
 * to test and to render onto a canvas, a DOM element, or anything else.
 */

export interface CompletionResult {
  line: string;
  options: string[];
}

export class TerminalModel {
  scrollback: string[] = [];
  input = '';
  cursor = 0;
  prompt = '$ ';
  busy = false;
  /** Rows scrolled up from the bottom (0 = following output). */
  scroll = 0;
  history: string[] = [];
  private historyIdx = -1;
  private draft = '';
  version = 0;
  maxScrollback = 2000;

  private touch(): void {
    this.version++;
  }

  print(...lines: string[]): void {
    for (const l of lines) this.scrollback.push(...l.split('\n'));
    if (this.scrollback.length > this.maxScrollback) this.scrollback.splice(0, this.scrollback.length - this.maxScrollback);
    this.scroll = 0;
    this.touch();
  }

  clear(): void {
    this.scrollback = [];
    this.scroll = 0;
    this.touch();
  }

  setPrompt(p: string): void {
    this.prompt = p;
    this.touch();
  }

  setBusy(b: boolean): void {
    this.busy = b;
    this.touch();
  }

  insert(text: string): void {
    const clean = text.replace(/\r?\n/g, ' ').replace(/[\x00-\x1f]/g, '');
    this.input = this.input.slice(0, this.cursor) + clean + this.input.slice(this.cursor);
    this.cursor += clean.length;
    this.scroll = 0;
    this.touch();
  }

  backspace(): void {
    if (this.cursor === 0) return;
    this.input = this.input.slice(0, this.cursor - 1) + this.input.slice(this.cursor);
    this.cursor--;
    this.touch();
  }

  deleteForward(): void {
    if (this.cursor >= this.input.length) return;
    this.input = this.input.slice(0, this.cursor) + this.input.slice(this.cursor + 1);
    this.touch();
  }

  deleteWordBack(): void {
    const before = this.input.slice(0, this.cursor);
    const trimmed = before.replace(/\S+\s*$/, '');
    this.input = trimmed + this.input.slice(this.cursor);
    this.cursor = trimmed.length;
    this.touch();
  }

  killToStart(): void {
    this.input = this.input.slice(this.cursor);
    this.cursor = 0;
    this.touch();
  }

  killToEnd(): void {
    this.input = this.input.slice(0, this.cursor);
    this.touch();
  }

  move(delta: number): void {
    this.cursor = Math.max(0, Math.min(this.input.length, this.cursor + delta));
    this.touch();
  }

  moveWord(dir: -1 | 1): void {
    if (dir < 0) {
      const m = /\S+\s*$/.exec(this.input.slice(0, this.cursor));
      this.cursor = m ? m.index : 0;
    } else {
      const m = /^\s*\S+/.exec(this.input.slice(this.cursor));
      this.cursor = m ? this.cursor + m[0].length : this.input.length;
    }
    this.touch();
  }

  home(): void {
    this.cursor = 0;
    this.touch();
  }

  end(): void {
    this.cursor = this.input.length;
    this.touch();
  }

  historyPrev(): void {
    if (!this.history.length) return;
    if (this.historyIdx === -1) {
      this.draft = this.input;
      this.historyIdx = this.history.length - 1;
    } else if (this.historyIdx > 0) this.historyIdx--;
    this.input = this.history[this.historyIdx];
    this.cursor = this.input.length;
    this.touch();
  }

  historyNext(): void {
    if (this.historyIdx === -1) return;
    if (this.historyIdx < this.history.length - 1) {
      this.historyIdx++;
      this.input = this.history[this.historyIdx];
    } else {
      this.historyIdx = -1;
      this.input = this.draft;
    }
    this.cursor = this.input.length;
    this.touch();
  }

  /** Accept the current line: echo it into scrollback and return it. */
  submit(): string {
    const line = this.input;
    this.print(this.prompt + line);
    if (line.trim() && this.history[this.history.length - 1] !== line) this.history.push(line);
    this.input = '';
    this.cursor = 0;
    this.historyIdx = -1;
    return line;
  }

  /** Ctrl+C: abandon the current line. */
  cancel(): void {
    this.print(this.prompt + this.input + '^C');
    this.input = '';
    this.cursor = 0;
    this.historyIdx = -1;
  }

  applyCompletion(r: CompletionResult): void {
    if (r.options.length) {
      this.print(this.prompt + this.input);
      this.print(r.options.join('  '));
    }
    this.input = r.line;
    this.cursor = this.input.length;
    this.touch();
  }

  scrollBy(rows: number, maxRows: number): void {
    this.scroll = Math.max(0, Math.min(maxRows, this.scroll + rows));
    this.touch();
  }
}

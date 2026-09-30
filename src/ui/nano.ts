/**
 * A small but faithful GNU nano. It exists so resolving merge conflicts and writing
 * commit messages feels like the real thing: Ctrl+O writes, Ctrl+X exits (asking
 * to save if modified), Ctrl+K / Ctrl+U cut and paste lines.
 *
 * The editor resolves with the file's content as last *saved* (or the original
 * content if never saved), exactly like a real editor writing to disk: that's
 * what git reads back after the editor exits.
 */

export type NanoMode = 'edit' | 'write-prompt' | 'exit-prompt' | 'exit-write-prompt' | 'help';

export interface NanoKey {
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

export class NanoEditor {
  lines: string[];
  row = 0;
  col = 0;
  top = 0;
  mode: NanoMode = 'edit';
  modified = false;
  status = '';
  promptInput = '';
  cutBuffer: string[] = [];
  private lastWasCut = false;
  private saved: string;
  version = 0;
  done = false;

  constructor(
    public filename: string,
    content: string,
    private onClose: (result: string) => void,
  ) {
    this.saved = content;
    this.lines = content.split('\n');
    if (this.lines.length > 1 && this.lines[this.lines.length - 1] === '') this.lines.pop();
    if (!this.lines.length) this.lines = [''];
    const n = this.lines.length;
    this.status = `[ Read ${n} line${n === 1 ? '' : 's'} ]`;
    // Git's commit templates start with an empty line for you to type into.
  }

  get text(): string {
    return this.lines.join('\n') + '\n';
  }

  private touch(): void {
    this.version++;
  }

  private clampCol(): void {
    this.col = Math.min(this.col, this.lines[this.row].length);
  }

  ensureVisible(rows: number): void {
    if (this.row < this.top) this.top = this.row;
    if (this.row >= this.top + rows) this.top = this.row - rows + 1;
  }

  private write(): void {
    this.saved = this.text;
    this.modified = false;
    const n = this.lines.length;
    this.status = `[ Wrote ${n} line${n === 1 ? '' : 's'} ]`;
  }

  private close(): void {
    this.done = true;
    this.onClose(this.saved);
  }

  handleKey(k: NanoKey): void {
    const key = k.key;
    this.touch();

    if (this.mode === 'help') {
      this.mode = 'edit';
      this.status = '';
      return;
    }

    if (this.mode === 'exit-prompt') {
      const lower = key.toLowerCase();
      if (lower === 'y') {
        this.mode = 'exit-write-prompt';
        this.promptInput = this.filename;
      } else if (lower === 'n') {
        this.close();
      } else if ((k.ctrl && lower === 'c') || key === 'Escape') {
        this.mode = 'edit';
        this.status = '[ Cancelled ]';
      }
      return;
    }

    if (this.mode === 'write-prompt' || this.mode === 'exit-write-prompt') {
      if (key === 'Enter') {
        this.write();
        if (this.mode === 'exit-write-prompt') {
          this.close();
          return;
        }
        this.mode = 'edit';
      } else if ((k.ctrl && key.toLowerCase() === 'c') || key === 'Escape') {
        this.mode = 'edit';
        this.status = '[ Cancelled ]';
      } else if (key === 'Backspace') {
        this.promptInput = this.promptInput.slice(0, -1);
      } else if (key.length === 1 && !k.ctrl) {
        this.promptInput += key;
      }
      return;
    }

    // --- edit mode ---
    if (k.ctrl) {
      const lower = key.toLowerCase();
      this.lastWasCut = lower === 'k' ? this.lastWasCut : false;
      switch (lower) {
        case 'o':
          this.mode = 'write-prompt';
          this.promptInput = this.filename;
          return;
        case 's':
          this.write();
          return;
        case 'x':
          if (this.modified) this.mode = 'exit-prompt';
          else this.close();
          return;
        case 'k': {
          const line = this.lines[this.row];
          if (!this.lastWasCut) this.cutBuffer = [];
          this.cutBuffer.push(line);
          this.lastWasCut = true;
          if (this.lines.length > 1) this.lines.splice(this.row, 1);
          else this.lines[0] = '';
          if (this.row >= this.lines.length) this.row = this.lines.length - 1;
          this.col = 0;
          this.modified = true;
          return;
        }
        case 'u':
          if (this.cutBuffer.length) {
            this.lines.splice(this.row, 0, ...this.cutBuffer);
            this.row += this.cutBuffer.length;
            this.col = 0;
            this.modified = true;
          }
          return;
        case 'g':
          this.mode = 'help';
          return;
        case 'c':
          this.status = `[ line ${this.row + 1}/${this.lines.length}, col ${this.col + 1}/${this.lines[this.row].length + 1} ]`;
          return;
        case 'a':
          this.col = 0;
          return;
        case 'e':
          this.col = this.lines[this.row].length;
          return;
        case 'home':
          this.row = 0;
          this.col = 0;
          return;
        case 'end':
          this.row = this.lines.length - 1;
          this.col = this.lines[this.row].length;
          return;
      }
      return;
    }
    this.lastWasCut = false;

    switch (key) {
      case 'ArrowLeft':
        if (this.col > 0) this.col--;
        else if (this.row > 0) {
          this.row--;
          this.col = this.lines[this.row].length;
        }
        return;
      case 'ArrowRight':
        if (this.col < this.lines[this.row].length) this.col++;
        else if (this.row < this.lines.length - 1) {
          this.row++;
          this.col = 0;
        }
        return;
      case 'ArrowUp':
        if (this.row > 0) this.row--;
        this.clampCol();
        return;
      case 'ArrowDown':
        if (this.row < this.lines.length - 1) this.row++;
        this.clampCol();
        return;
      case 'Home':
        this.col = 0;
        return;
      case 'End':
        this.col = this.lines[this.row].length;
        return;
      case 'PageUp':
        this.row = Math.max(0, this.row - 20);
        this.clampCol();
        return;
      case 'PageDown':
        this.row = Math.min(this.lines.length - 1, this.row + 20);
        this.clampCol();
        return;
      case 'Enter': {
        const line = this.lines[this.row];
        this.lines[this.row] = line.slice(0, this.col);
        this.lines.splice(this.row + 1, 0, line.slice(this.col));
        this.row++;
        this.col = 0;
        this.modified = true;
        this.status = '';
        return;
      }
      case 'Backspace':
        if (this.col > 0) {
          const line = this.lines[this.row];
          this.lines[this.row] = line.slice(0, this.col - 1) + line.slice(this.col);
          this.col--;
          this.modified = true;
        } else if (this.row > 0) {
          const prev = this.lines[this.row - 1];
          this.lines[this.row - 1] = prev + this.lines[this.row];
          this.lines.splice(this.row, 1);
          this.row--;
          this.col = prev.length;
          this.modified = true;
        }
        return;
      case 'Delete': {
        const line = this.lines[this.row];
        if (this.col < line.length) {
          this.lines[this.row] = line.slice(0, this.col) + line.slice(this.col + 1);
          this.modified = true;
        } else if (this.row < this.lines.length - 1) {
          this.lines[this.row] = line + this.lines[this.row + 1];
          this.lines.splice(this.row + 1, 1);
          this.modified = true;
        }
        return;
      }
      case 'Tab':
        this.insertText('  ');
        return;
      case 'Escape':
        return;
    }
    if (key.length === 1) this.insertText(key);
  }

  insertText(text: string): void {
    const parts = text.replace(/\r/g, '').split('\n');
    parts.forEach((part, i) => {
      if (i > 0) this.handleKey({ key: 'Enter', ctrl: false, alt: false, shift: false });
      const line = this.lines[this.row];
      this.lines[this.row] = line.slice(0, this.col) + part + line.slice(this.col);
      this.col += part.length;
    });
    if (text) {
      this.modified = true;
      this.status = '';
    }
    this.touch();
  }
}

export const NANO_SHORTCUTS: Array<[string, string]> = [
  ['^G', 'Help'],
  ['^O', 'Write Out'],
  ['^X', 'Exit'],
  ['^K', 'Cut'],
  ['^U', 'Paste'],
  ['^C', 'Location'],
];

export const NANO_HELP = [
  'Main nano help text',
  '',
  ' The nano editor is designed to emulate the functionality and ease-of-use',
  ' of the UW Pico text editor. (This one is a Conglomo Corp. Managed Build.)',
  '',
  ' ^O   Write Out: save the file (then press Enter to confirm the name)',
  ' ^X   Exit: close nano (you will be asked to save if there are changes)',
  ' ^K   Cut the current line          ^U   Paste the cut line(s)',
  ' ^C   Show the cursor position       ^S   Save without asking',
  ' Arrows / Home / End / PgUp / PgDn   Move around',
  '',
  ' Resolving a merge conflict? Delete the <<<<<<<, =======, >>>>>>> lines',
  ' (^K cuts a whole line) and leave the file the way it should end up.',
  '',
  ' Press any key to return.',
];

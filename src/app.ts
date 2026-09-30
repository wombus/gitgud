import { Sfx } from './audio/sfx';
import { character } from './game/characters';
import { Director, type LevelReport, type ObjectiveStatus } from './game/director';
import { LEVELS } from './game/levels';
import { loadSave, resetSave, writeSave, type SaveData } from './game/save';
import type { Incident } from './game/types';
import { OfficeRenderer, type Focus, type Quality } from './render/scene';
import { NanoEditor, type NanoKey } from './ui/nano';
import { ChatScreen } from './ui/screens/chat-screen';
import { TerminalScreen } from './ui/screens/terminal-screen';
import { TerminalModel } from './ui/terminal-model';

/**
 * Glue between the pieces: the Director (game rules), the terminal model and nano
 * (input), the two screen canvases, the 3D office, the DOM HUD/menus, and audio.
 */

type State = 'title' | 'playing' | 'paused' | 'review' | 'incident' | 'menu';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const BASE_FONT = 27;

function hourOf(clock: string): number {
  const m = /(\d\d):(\d\d)/.exec(clock)!;
  return +m[1] + +m[2] / 60;
}

function dayLabel(clock: string): string {
  const d = new Date(`${clock.replace(' ', 'T')}:00Z`);
  const day = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
  let h = d.getUTCHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${day} · ${h}:${String(d.getUTCMinutes()).padStart(2, '0')} ${ampm}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
}

/** `code` spans become <code>; everything else is escaped. */
function richText(s: string): string {
  return s
    .split('`')
    .map((part, i) => (i % 2 ? `<code>${escapeHtml(part)}</code>` : escapeHtml(part)))
    .join('')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

export class App {
  save: SaveData = loadSave();
  sfx = new Sfx();
  model = new TerminalModel();
  term!: TerminalScreen;
  chat = new ChatScreen();
  renderer: OfficeRenderer | null = null;
  director: Director | null = null;
  levelIndex = 0;
  state: State = 'title';
  private previousState: State = 'title';
  private running = false;
  private unread = 0;
  private lastObjectives: ObjectiveStatus[] = [];
  private kbd = $<HTMLTextAreaElement>('kbd');
  private edgeTimer: number | null = null;
  private autoChat = false;
  private flat = false;
  private lastReport: LevelReport | null = null;

  async init(): Promise<void> {
    this.term = new TerminalScreen(this.model);
    this.applySettings(false);
    this.flat = this.save.settings.quality === 'flat' || !OfficeRenderer.supported();
    this.setupRenderer();
    this.wireInput();
    this.wireMenus();
    this.showTitle();
    setInterval(() => this.tick(), 1000);
    const loop = (now: number) => {
      this.frame(now);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  /* ------------------------------ rendering ------------------------------ */

  private setupRenderer(): void {
    const stage = $('stage');
    const flat = $('flat');
    if (this.renderer) {
      this.renderer.renderer.dispose();
      stage.innerHTML = '';
      this.renderer = null;
    }
    flat.innerHTML = '';
    if (this.flat) {
      stage.hidden = true;
      flat.hidden = false;
      this.term.canvas.className = 'flat-term';
      this.chat.canvas.className = 'flat-chat';
      flat.append(this.term.canvas, this.chat.canvas);
      return;
    }
    stage.hidden = false;
    flat.hidden = true;
    try {
      this.renderer = new OfficeRenderer(stage, this.term.canvas, this.chat.canvas, this.playerName());
      const q = this.save.settings.quality;
      this.renderer.setQuality(q === 'flat' ? 'high' : q);
      this.renderer.reduceMotion = this.save.settings.reduceMotion;
    } catch (e) {
      console.error('WebGL failed, falling back to flat mode', e);
      this.flat = true;
      this.setupRenderer();
    }
  }

  private frame(now: number): void {
    const t = this.term.render(now);
    const ch = this.chat.render(now);
    if (this.renderer) {
      this.renderer.markScreensDirty(t, ch);
      this.renderer.frame();
    }
  }

  private tick(): void {
    if (this.state !== 'playing' || !this.director) return;
    this.director.tick();
    const label = this.director.clockLabel();
    this.term.clock = label;
    $('hud-clock').textContent = label;
  }

  private playerName(): string {
    return this.save.identity?.name ?? 'Junior Dev';
  }

  private setFocus(f: Focus): void {
    this.renderer?.setFocus(f);
    for (const v of ['terminal', 'chat', 'overview'] as Focus[]) $(`view-${v}`).setAttribute('aria-pressed', String(v === f));
    if (f === 'chat') {
      this.unread = 0;
      this.updateUnread();
    }
  }

  /**
   * Views behave like toggles: choosing the view you're already in takes you back
   * to the terminal (the "home" view). Shared by the HUD buttons and F2/F3.
   */
  private toggleView(v: Focus): void {
    this.autoChat = false;
    this.setFocus(v !== 'terminal' && this.currentFocus() === v ? 'terminal' : v);
  }

  private currentFocus(): Focus {
    return this.renderer?.focus ?? 'terminal';
  }

  private updateUnread(): void {
    const el = $('unread');
    el.hidden = this.unread === 0;
    el.textContent = String(this.unread);
  }

  /* -------------------------------- screens ------------------------------ */

  private show(id: string | null): void {
    for (const s of ['title', 'levels', 'settings', 'pause', 'review', 'incident']) $(s).hidden = s !== id;
    $('hud').hidden = !(this.state === 'playing' || this.state === 'paused');
    $('checklist').hidden = !this.save.settings.showHud;
  }

  private showTitle(): void {
    this.state = 'title';
    this.director = null;
    this.show('title');
    this.setFocus('overview');
    this.renderer?.setHour(18.2);
    const anyDone = Object.keys(this.save.completed).length > 0;
    $('start-label').textContent = anyDone ? `clock in  # ${this.nextLevel().ticket}` : 'clock in';
    this.model.clear();
    this.term.editor = null;
    this.term.ticket = '';
    this.term.clock = '';
    this.term.title = 'Conglomo OS';
    this.term.bootLines = [
      '\x1b[1mConglomo OS 11 (Managed Build)\x1b[0m · DESKTOP-GARY · tty1',
      '',
      'This computer is the property of Conglomo Corp. Unauthorized use is prohibited.',
      'Authorized use is discouraged.',
      '',
      '\x1b[90mLast login: Fri Feb 13 17:59:58 by gary.pruitt (account disabled)\x1b[0m',
      '',
      'login: _',
    ];
    this.chat.reset();
    this.chat.ticket = { id: '', title: 'Clock in to get your first ticket', summary: '' };
    this.chat.objectives = [];
    this.chat.messages = [
      { id: 1, from: 'people', text: '🎉 Welcome to Conglomo Corp! Your onboarding starts the moment you clock in. Please enjoy responsibly.', time: 1772456400, channel: 'people' },
    ];
    requestAnimationFrame(() => ($('btn-start') as HTMLButtonElement).focus());
  }

  private nextLevel() {
    return LEVELS.find((l) => !this.save.completed[l.id]) ?? LEVELS[LEVELS.length - 1];
  }

  private renderLevelList(): void {
    const list = $('level-list');
    list.innerHTML = '';
    const next = this.nextLevel();
    LEVELS.forEach((l, i) => {
      const done = this.save.completed[l.id];
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.innerHTML = `
        <span class="t-id">${l.ticket}</span>
        <span class="t-body"><span class="t-title">${escapeHtml(l.title)}</span><span class="t-sum">${escapeHtml(l.summary)}</span></span>
        <span class="t-status ${done ? 'done' : l === next ? 'next' : ''}">${done ? `${'★'.repeat(done.stars)}${'☆'.repeat(3 - done.stars)}` : l === next ? 'up next' : 'open'}</span>`;
      b.addEventListener('click', () => this.startLevel(i));
      li.append(b);
      list.append(li);
    });
  }

  private openPanel(id: 'levels' | 'settings'): void {
    this.previousState = this.state;
    if (this.state === 'playing') this.state = 'paused';
    if (id === 'levels') this.renderLevelList();
    if (id === 'settings') this.syncSettingsForm();
    this.show(id);
    const first = $(id).querySelector('button, select, input') as HTMLElement | null;
    first?.focus();
  }

  private closePanel(): void {
    if (this.previousState === 'title' || !this.director) this.showTitle();
    else if (this.previousState === 'review') this.show('review');
    else if (this.previousState === 'incident') this.show('incident');
    else this.openPause();
  }

  private openPause(): void {
    if (!this.director) return;
    this.state = 'paused';
    $('pause-ticket').textContent = `${this.director.level.ticket} · ${this.director.level.title}`;
    this.show('pause');
    ($('btn-resume') as HTMLButtonElement).focus();
  }

  private resume(): void {
    if (!this.director) return;
    this.state = 'playing';
    this.show(null);
    this.focusKeyboard();
  }

  /* -------------------------------- levels ------------------------------- */

  async startLevel(i: number): Promise<void> {
    this.levelIndex = i;
    const level = LEVELS[i];
    this.state = 'menu';
    this.show(null);
    const curtain = $('curtain');
    $('curtain-day').textContent = dayLabel(level.clock);
    $('curtain-ticket').textContent = `${level.ticket}: ${level.title}`;
    curtain.classList.remove('fade');
    curtain.hidden = false;

    this.model.clear();
    this.model.history = [];
    this.term.editor = null;
    this.term.bootLines = null;
    this.term.toasts = [];
    this.chat.reset();
    this.unread = 0;
    this.updateUnread();
    this.lastObjectives = [];

    const director = new Director(level, {
      editor: (file, content) => this.openEditor(file, content),
      identity: this.save.identity,
      callbacks: {
        onMessage: (m) => {
          this.chat.messages.push(m);
          this.sfx.ping();
          if (this.currentFocus() !== 'chat') {
            const ch = character(m.from);
            this.term.pushToast({ name: ch.name, initials: ch.initials, color: ch.color, text: m.text }, performance.now());
            this.unread++;
            this.updateUnread();
          }
        },
        onTyping: (who) => (this.chat.typing = who),
        onObjectives: (list) => this.updateObjectives(list),
        onComplete: (r) => this.onComplete(r),
        onFail: (inc) => this.onFail(inc),
        onRestartRequest: () => void this.startLevel(this.levelIndex),
      },
    });
    this.director = director;
    await director.start({ intro: false });
    if (this.director !== director) return;

    this.renderer?.setHour(hourOf(level.clock));
    this.renderer?.setPlayerName(level.machine ? character('todd').name : this.playerName());
    this.chat.ticket = { id: level.ticket, title: level.title, summary: level.summary };
    $('hud-ticket').textContent = level.ticket;
    $('hud-title').textContent = level.title;
    $('hud-clock').textContent = director.clockLabel();
    this.term.ticket = level.ticket;
    this.term.clock = director.clockLabel();
    this.refreshPrompt();
    const sh = director.shell;
    const motd = [
      `\x1b[90mLast login: ${dayLabel(level.clock).split(' · ')[0]} on ttys00${i % 10}\x1b[0m`,
      level.machine
        ? `\x1b[33m⚠ Remote session: you are logged in to ${sh.world.user}@${sh.world.host}. Be gentle.\x1b[0m`
        : `\x1b[90mTip: \x1b[36mtask\x1b[90m shows your ticket · \x1b[36mhint\x1b[90m if stuck · \x1b[36mhelp\x1b[90m lists commands\x1b[0m`,
      '',
    ];
    this.model.print(...motd);
    this.setFocus('terminal');
    this.renderer?.snapCamera();

    window.setTimeout(() => {
      curtain.classList.add('fade');
      window.setTimeout(() => (curtain.hidden = true), 800);
      if (this.director !== director) return;
      this.state = 'playing';
      this.show(null);
      this.checklistPinned = false;
      // On narrow screens the checklist would cover the terminal; start folded.
      this.showChecklist(window.innerWidth > 720, 12000);
      this.focusKeyboard();
      director.introduce();
    }, this.save.settings.reduceMotion ? 600 : 1700);
  }

  private refreshPrompt(): void {
    const d = this.director;
    if (!d) return;
    this.model.setPrompt(d.shell.prompt());
    this.term.title = `${d.shell.world.user}@${d.shell.world.host.toLowerCase()}: ${d.shell.fs.displayPath(d.shell.cwd)} — zsh`;
  }

  private checklistPinned = false;
  private checklistTimer: number | null = null;

  /** Expand the checklist HUD; `autoCollapseMs` folds it away again unless the player pinned it. */
  private showChecklist(expanded: boolean, autoCollapseMs = 0): void {
    const el = $('checklist');
    el.classList.toggle('collapsed', !expanded);
    $('checklist-toggle').setAttribute('aria-expanded', String(expanded));
    if (this.checklistTimer !== null) clearTimeout(this.checklistTimer);
    this.checklistTimer = null;
    if (expanded && autoCollapseMs && !this.checklistPinned) {
      this.checklistTimer = window.setTimeout(() => this.showChecklist(false), autoCollapseMs);
    }
  }

  private updateObjectives(list: ObjectiveStatus[]): void {
    const ul = $('hud-objectives');
    const prev = new Map(this.lastObjectives.map((o) => [o.id, o.done]));
    ul.innerHTML = '';
    let newlyDone = false;
    for (const o of list) {
      const li = document.createElement('li');
      li.innerHTML = richText(o.text);
      if (o.done) li.classList.add('done');
      if (o.done && prev.get(o.id) === false) {
        li.classList.add('just-done');
        newlyDone = true;
      }
      ul.append(li);
    }
    if (newlyDone) {
      this.sfx.checkmark();
      if (!this.checklistPinned && window.innerWidth > 720) this.showChecklist(true, 4500);
    }
    $('hud-progress').textContent = `${list.filter((o) => o.done).length}/${list.length} done`;
    this.lastObjectives = list;
    this.chat.objectives = list;
  }

  private onComplete(r: LevelReport): void {
    this.lastReport = r;
    const level = r.level;
    const prev = this.save.completed[level.id];
    if (!prev || prev.stars < r.stars) this.save.completed[level.id] = { stars: r.stars, rating: r.rating };
    if (level.identity === null && this.director) {
      const name = this.director.world.globalConfig.get('user.name');
      const email = this.director.world.globalConfig.get('user.email');
      if (name && email) {
        this.save.identity = { name, email };
        this.renderer?.setPlayerName(name);
      }
    }
    writeSave(this.save);
    this.sfx.success();
    this.state = 'review';
    this.fillReview(r);
    this.show('review');
    ($('btn-next') as HTMLButtonElement).focus();
  }

  private fillReview(r: LevelReport): void {
    const level = r.level;
    $('review-date').textContent = dayLabel(level.clock).split(' · ')[0];
    $('review-employee').textContent = level.machine ? `${this.playerName()} (on Todd's laptop)` : this.playerName();
    $('review-ticket').textContent = `${level.ticket}: ${level.title}`;
    document.querySelectorAll<HTMLElement>('.rating .box').forEach((b) => b.classList.toggle('checked', Number(b.dataset.rating) === r.stars));
    $('review-stamp').textContent = r.stars === 3 ? 'Exceeds' : r.stars === 2 ? 'Meets' : 'See me';
    const mins = Math.floor(r.seconds / 60);
    const secs = String(r.seconds % 60).padStart(2, '0');
    const rows: Array<[string, string]> = [
      ['Commands that changed something', `${r.workCommands}  (par ${level.par})`],
      ['Commands run in total', String(r.commands)],
      ['Errors', String(r.errors)],
      ['Hints requested', String(r.hints)],
      ['Time on ticket', `${mins}:${secs}`],
      ['Skills demonstrated', level.concepts.join(', ')],
    ];
    $('review-metrics').innerHTML = rows.map(([k, v]) => `<tr><th scope="row">${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join('');
    $('review-debrief-title').textContent = `Manager's notes: ${level.debrief.title}`;
    $('review-debrief').innerHTML = level.debrief.points.map((p) => `<li>${richText(p)}</li>`).join('');
    const last = this.levelIndex >= LEVELS.length - 1;
    $('btn-next').textContent = last ? 'Finish the week' : 'Next ticket';
  }

  private onFail(inc: Incident): void {
    this.sfx.fail();
    this.state = 'incident';
    const level = LEVELS[this.levelIndex];
    const from = character(inc.from);
    $('incident-no').textContent = `${4400 + Math.floor(Math.random() * 500)}-${'ABCDEFG'[Math.floor(Math.random() * 7)]}`;
    $('incident-from').textContent = `${from.name}, ${from.title}`;
    $('incident-ticket').textContent = `${level.ticket}: ${level.title}`;
    $('incident-title').textContent = inc.title;
    $('incident-body').innerHTML = richText(inc.body);
    this.show('incident');
    ($('btn-retry') as HTMLButtonElement).focus();
  }

  /* --------------------------------- input ------------------------------- */

  private openEditor(file: string, content: string): Promise<string | null> {
    return new Promise((resolve) => {
      this.term.editor = new NanoEditor(file, content, (result) => {
        this.term.editor = null;
        resolve(result);
      });
    });
  }

  private focusKeyboard(): void {
    if (this.state !== 'playing') return;
    this.kbd.focus({ preventScroll: true });
    $('focus-hint').hidden = true;
  }

  private async submitLine(): Promise<void> {
    const d = this.director;
    if (!d || this.running) return;
    const line = this.model.submit();
    this.running = true;
    this.model.setBusy(true);
    try {
      const res = await d.runCommand(line);
      if (this.director !== d) return;
      if (res.clear) this.model.clear();
      if (res.lines.length) this.model.print(...res.lines);
    } catch (e) {
      console.error(e);
      this.model.print(`\x1b[31mgitgud: internal error: ${(e as Error).message}\x1b[0m`);
    } finally {
      this.running = false;
      this.model.setBusy(false);
      this.refreshPrompt();
    }
  }

  private terminalKey(e: KeyboardEvent): boolean {
    const m = this.model;
    const ctrl = e.ctrlKey || e.metaKey;
    if (this.running) return e.key.length > 1 || ctrl;
    if (ctrl && !e.altKey) {
      switch (e.key.toLowerCase()) {
        case 'c':
          if (window.getSelection()?.toString()) return false;
          m.cancel();
          return true;
        case 'l':
          m.clear();
          return true;
        case 'a':
          m.home();
          return true;
        case 'e':
          m.end();
          return true;
        case 'u':
          m.killToStart();
          return true;
        case 'k':
          m.killToEnd();
          return true;
        case 'w':
          m.deleteWordBack();
          return true;
        case 'arrowleft':
          m.moveWord(-1);
          return true;
        case 'arrowright':
          m.moveWord(1);
          return true;
        case 'v':
          return false; // let paste happen
      }
      return false;
    }
    switch (e.key) {
      case 'Enter':
        void this.submitLine();
        return true;
      case 'Backspace':
        if (e.altKey) m.deleteWordBack();
        else m.backspace();
        return true;
      case 'Delete':
        m.deleteForward();
        return true;
      case 'ArrowLeft':
        if (e.altKey) m.moveWord(-1);
        else m.move(-1);
        return true;
      case 'ArrowRight':
        if (e.altKey) m.moveWord(1);
        else m.move(1);
        return true;
      case 'ArrowUp':
        m.historyPrev();
        return true;
      case 'ArrowDown':
        m.historyNext();
        return true;
      case 'Home':
        m.home();
        return true;
      case 'End':
        m.end();
        return true;
      case 'PageUp':
        m.scrollBy(this.term.rows - 2, this.term.maxScroll());
        return true;
      case 'PageDown':
        m.scrollBy(-(this.term.rows - 2), this.term.maxScroll());
        return true;
      case 'Tab': {
        const d = this.director;
        if (d) {
          const before = m.input.slice(0, m.cursor);
          const r = d.shell.complete(before);
          const after = m.input.slice(m.cursor);
          m.applyCompletion({ line: r.line + after, options: r.options });
          m.cursor = r.line.length;
        }
        return true;
      }
    }
    return false;
  }

  private editorKey(ed: NanoEditor, e: KeyboardEvent): boolean {
    const special = ['Enter', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Tab', 'Escape'];
    const ctrl = e.ctrlKey || e.metaKey;
    const promptMode = ed.mode !== 'edit';
    if (ctrl || special.includes(e.key) || (promptMode && e.key.length === 1)) {
      if (ctrl && e.key.toLowerCase() === 'v') return false;
      const k: NanoKey = { key: e.key, ctrl, alt: e.altKey, shift: e.shiftKey };
      ed.handleKey(k);
      return true;
    }
    return false;
  }

  private wireInput(): void {
    const kbd = this.kbd;
    kbd.addEventListener('keydown', (e) => {
      this.sfx.unlock();
      this.renderer?.pressKey(e.code);
      if (!e.repeat) this.sfx.key(e.code);
      if (this.state !== 'playing') return;
      if (e.key === 'F2' || e.key === 'F3') {
        e.preventDefault();
        this.toggleView(e.key === 'F2' ? 'chat' : 'overview');
        return;
      }
      const ed = this.term.editor;
      if (!ed && e.key === 'Escape') {
        e.preventDefault();
        this.openPause();
        return;
      }
      const handled = ed ? this.editorKey(ed, e) : this.terminalKey(e);
      if (handled) e.preventDefault();
    });
    kbd.addEventListener('input', () => {
      const v = kbd.value;
      kbd.value = '';
      if (!v || this.state !== 'playing') return;
      const ed = this.term.editor;
      if (ed) {
        if (ed.mode === 'edit') ed.insertText(v);
        else for (const ch of v) ed.handleKey({ key: ch, ctrl: false, alt: false, shift: false });
      } else if (!this.running) this.model.insert(v);
    });
    kbd.addEventListener('beforeinput', (e) => {
      // Phone keyboards send deletes as input events rather than key presses.
      if (e.inputType === 'deleteContentBackward' && kbd.value === '') {
        e.preventDefault();
        const ed = this.term.editor;
        if (ed) ed.handleKey({ key: 'Backspace', ctrl: false, alt: false, shift: false });
        else this.model.backspace();
      }
    });
    kbd.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = e.clipboardData?.getData('text') ?? '';
      const ed = this.term.editor;
      if (ed) ed.insertText(text);
      else this.model.insert(text.split(/\r?\n/)[0]);
    });
    kbd.addEventListener('blur', () => {
      if (this.state === 'playing') window.setTimeout(() => ($('focus-hint').hidden = document.activeElement === kbd || this.state !== 'playing'), 150);
    });

    const app = $('app');
    app.addEventListener('pointerdown', (e) => {
      this.sfx.unlock();
      const target = e.target as HTMLElement;
      if (this.state === 'playing' && !target.closest('button, select, input, a')) {
        e.preventDefault();
        // Clicking a monitor looks at it (e.g. to get back from "Lean back").
        const screen = this.renderer?.pickScreen(e.clientX, e.clientY);
        if (screen && screen !== this.currentFocus()) {
          this.autoChat = false;
          this.setFocus(screen);
        }
        this.focusKeyboard();
      }
    });
    app.addEventListener('mousemove', (e) => {
      const x = e.clientX / window.innerWidth;
      const y = e.clientY / window.innerHeight;
      this.renderer?.setGaze(x * 2 - 1, y * 2 - 1);
      if (this.state !== 'playing' || !this.renderer) return;
      // Glance at Pingr by pushing the mouse against the left edge.
      if (x < 0.04 && this.currentFocus() === 'terminal') {
        if (this.edgeTimer === null) {
          this.edgeTimer = window.setTimeout(() => {
            this.autoChat = true;
            this.setFocus('chat');
            this.edgeTimer = null;
          }, 350);
        }
      } else if (this.edgeTimer !== null) {
        clearTimeout(this.edgeTimer);
        this.edgeTimer = null;
      }
      if (this.autoChat && x > 0.6 && this.currentFocus() === 'chat') {
        this.autoChat = false;
        this.setFocus('terminal');
      }
    });
    app.addEventListener(
      'wheel',
      (e) => {
        if (this.state !== 'playing' || this.term.editor) return;
        this.model.scrollBy(e.deltaY < 0 ? 3 : -3, this.term.maxScroll());
      },
      { passive: true },
    );
    document.addEventListener('keydown', (e) => {
      // Keys pressed while the hidden textarea isn't focused (e.g. in menus).
      if (e.target === kbd) return;
      if (e.key === 'Escape') {
        if (this.state === 'paused' && !$('pause').hidden) this.resume();
        else if (!$('levels').hidden || !$('settings').hidden) this.closePanel();
      } else if (this.state === 'playing' && !(e.target as HTMLElement).closest('input, select, textarea')) {
        this.focusKeyboard();
      }
    });
  }

  private wireMenus(): void {
    const on = (id: string, fn: () => void) => $(id).addEventListener('click', () => {
      this.sfx.unlock();
      fn();
    });
    on('btn-start', () => void this.startLevel(LEVELS.indexOf(this.nextLevel())));
    on('btn-levels', () => this.openPanel('levels'));
    on('btn-settings', () => this.openPanel('settings'));
    document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => this.closePanel()));
    on('btn-resume', () => this.resume());
    on('btn-restart', () => void this.startLevel(this.levelIndex));
    on('btn-pause-levels', () => this.openPanel('levels'));
    on('btn-pause-settings', () => this.openPanel('settings'));
    on('btn-quit', () => this.showTitle());
    on('btn-pause', () => this.openPause());
    on('btn-next', () => {
      if (this.levelIndex >= LEVELS.length - 1) this.showTitle();
      else void this.startLevel(this.levelIndex + 1);
    });
    on('btn-replay', () => void this.startLevel(this.levelIndex));
    on('btn-review-levels', () => this.openPanel('levels'));
    on('btn-retry', () => void this.startLevel(this.levelIndex));
    on('btn-incident-levels', () => this.openPanel('levels'));
    on('checklist-toggle', () => {
      const collapsed = $('checklist').classList.contains('collapsed');
      this.checklistPinned = true;
      this.showChecklist(collapsed);
      this.focusKeyboard();
    });
    for (const v of ['terminal', 'chat', 'overview'] as Focus[]) {
      on(`view-${v}`, () => {
        this.toggleView(v);
        this.focusKeyboard();
      });
    }

    // Settings
    const quality = $<HTMLSelectElement>('set-quality');
    quality.addEventListener('change', () => {
      const q = quality.value as Quality | 'flat';
      this.save.settings.quality = q;
      writeSave(this.save);
      const wantFlat = q === 'flat' || !OfficeRenderer.supported();
      if (wantFlat !== this.flat || (!this.renderer && !wantFlat)) {
        this.flat = wantFlat;
        this.setupRenderer();
        if (this.director) {
          this.renderer?.setHour(hourOf(this.director.level.clock));
          this.setFocus('terminal');
        } else this.renderer?.setFocus('overview');
      } else if (q !== 'flat') this.renderer?.setQuality(q);
    });
    $<HTMLInputElement>('set-volume').addEventListener('input', (e) => {
      this.save.settings.volume = Number((e.target as HTMLInputElement).value);
      this.sfx.setVolume(this.save.settings.volume);
      writeSave(this.save);
    });
    $<HTMLSelectElement>('set-font').addEventListener('change', (e) => {
      this.save.settings.fontScale = Number((e.target as HTMLSelectElement).value);
      this.applySettings(true);
      writeSave(this.save);
    });
    $<HTMLInputElement>('set-hud').addEventListener('change', (e) => {
      this.save.settings.showHud = (e.target as HTMLInputElement).checked;
      $('checklist').hidden = !this.save.settings.showHud;
      writeSave(this.save);
    });
    $<HTMLInputElement>('set-motion').addEventListener('change', (e) => {
      this.save.settings.reduceMotion = (e.target as HTMLInputElement).checked;
      if (this.renderer) this.renderer.reduceMotion = this.save.settings.reduceMotion;
      writeSave(this.save);
    });
    $<HTMLInputElement>('set-mute').addEventListener('change', (e) => {
      this.save.settings.muted = (e.target as HTMLInputElement).checked;
      this.sfx.setMuted(this.save.settings.muted);
      writeSave(this.save);
    });
    on('btn-reset', () => ($('reset-confirm').hidden = false));
    on('btn-reset-no', () => ($('reset-confirm').hidden = true));
    on('btn-reset-yes', () => {
      this.save = resetSave();
      $('reset-confirm').hidden = true;
      this.renderer?.setPlayerName(this.playerName());
      this.syncSettingsForm();
    });
  }

  private syncSettingsForm(): void {
    const s = this.save.settings;
    $<HTMLSelectElement>('set-quality').value = this.flat ? 'flat' : s.quality;
    $<HTMLInputElement>('set-volume').value = String(s.volume);
    $<HTMLSelectElement>('set-font').value = String(s.fontScale);
    $<HTMLInputElement>('set-hud').checked = s.showHud;
    $<HTMLInputElement>('set-motion').checked = s.reduceMotion;
    $<HTMLInputElement>('set-mute').checked = s.muted;
    $('reset-confirm').hidden = true;
  }

  private applySettings(fontOnly: boolean): void {
    const s = this.save.settings;
    this.term.setFontSize(Math.round(BASE_FONT * s.fontScale));
    if (fontOnly) return;
    this.sfx.setVolume(s.volume);
    this.sfx.setMuted(s.muted);
  }

  /** For debugging and automated smoke tests. */
  debugState() {
    return { state: this.state, level: LEVELS[this.levelIndex]?.id, objectives: this.lastObjectives, report: this.lastReport };
  }
}

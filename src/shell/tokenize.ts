/**
 * A small POSIX-ish shell tokenizer. Enough for what players type at a real
 * prompt: quotes, escapes, `&&`, `||`, `;`, pipes, and `>` / `>>` redirection.
 *
 * A command line becomes a list of pipelines joined by operators:
 *   git add . && git commit -m "fix" | cat > log.txt
 */

export interface Word {
  text: string;
  /** Contained an unquoted * or ? (eligible for glob expansion). */
  glob: boolean;
}

export interface SimpleCommand {
  words: Word[];
  redirect?: { append: boolean; target: string };
}

export interface Pipeline {
  commands: SimpleCommand[];
  /** Operator connecting this pipeline to the *previous* one. */
  op: '&&' | '||' | ';' | null;
}

export class ShellSyntaxError extends Error {}

type Tok = { kind: 'word'; word: Word } | { kind: 'op'; op: string };

function lex(line: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  let cur = '';
  let glob = false;
  let inWord = false;
  const flush = () => {
    if (inWord) toks.push({ kind: 'word', word: { text: cur, glob } });
    cur = '';
    glob = false;
    inWord = false;
  };
  while (i < line.length) {
    const ch = line[i];
    if (ch === ' ' || ch === '\t') {
      flush();
      i++;
      continue;
    }
    if (ch === '#' && !inWord) break;
    if (ch === '\\') {
      if (i + 1 < line.length) cur += line[i + 1];
      inWord = true;
      i += 2;
      continue;
    }
    if (ch === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) throw new ShellSyntaxError("zsh: unmatched '");
      cur += line.slice(i + 1, end);
      inWord = true;
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let s = '';
      while (j < line.length && line[j] !== '"') {
        if (line[j] === '\\' && j + 1 < line.length && '"\\$`'.includes(line[j + 1])) {
          s += line[j + 1];
          j += 2;
        } else {
          s += line[j];
          j++;
        }
      }
      if (j >= line.length) throw new ShellSyntaxError('zsh: unmatched "');
      cur += s;
      inWord = true;
      i = j + 1;
      continue;
    }
    const two = line.slice(i, i + 2);
    if (two === '&&' || two === '||' || two === '>>') {
      flush();
      toks.push({ kind: 'op', op: two });
      i += 2;
      continue;
    }
    if (two === '2>' && !inWord) {
      // stderr redirection: we don't separate stderr, so just swallow `2>&1` / `2>/dev/null`.
      const m = /^2>(&1|\s*\/dev\/null)/.exec(line.slice(i));
      if (m) {
        flush();
        i += m[0].length;
        continue;
      }
    }
    if (ch === ';' || ch === '|' || ch === '>') {
      flush();
      toks.push({ kind: 'op', op: ch });
      i++;
      continue;
    }
    if (ch === '&') {
      throw new ShellSyntaxError('zsh: background jobs are disabled on this machine');
    }
    if ((ch === '*' || ch === '?') && true) glob = true;
    cur += ch;
    inWord = true;
    i++;
  }
  flush();
  return toks;
}

export function parseCommandLine(line: string): Pipeline[] {
  const toks = lex(line);
  const pipelines: Pipeline[] = [];
  let pipeline: Pipeline = { commands: [], op: null };
  let cmd: SimpleCommand = { words: [] };

  const endCommand = () => {
    if (!cmd.words.length) {
      if (cmd.redirect) throw new ShellSyntaxError('zsh: parse error near `>\'');
      return false;
    }
    pipeline.commands.push(cmd);
    cmd = { words: [] };
    return true;
  };

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind === 'word') {
      cmd.words.push(t.word);
      continue;
    }
    switch (t.op) {
      case '>':
      case '>>': {
        const next = toks[i + 1];
        if (!next || next.kind !== 'word') throw new ShellSyntaxError('zsh: parse error near `\\n\'');
        cmd.redirect = { append: t.op === '>>', target: next.word.text };
        i++;
        break;
      }
      case '|':
        if (!endCommand()) throw new ShellSyntaxError("zsh: parse error near `|'");
        break;
      case '&&':
      case '||':
      case ';': {
        if (!endCommand() && t.op !== ';') throw new ShellSyntaxError(`zsh: parse error near \`${t.op}'`);
        if (pipeline.commands.length) pipelines.push(pipeline);
        pipeline = { commands: [], op: t.op as Pipeline['op'] };
        break;
      }
    }
  }
  endCommand();
  if (pipeline.commands.length) pipelines.push(pipeline);
  else if (pipeline.op === '&&' || pipeline.op === '||') throw new ShellSyntaxError(`zsh: parse error near \`${pipeline.op}'`);
  return pipelines;
}

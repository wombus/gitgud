import { print, requireRepo, type GitContext } from '../context';
import { commitHeader, diffFileMaps, formatStat } from '../format';
import { shortHash, subject, type Hash } from '../objects';
import type { Repository } from '../repo';
import { revParseCommit } from '../revparse';
import { failure, fatal, plural } from '../util';
import { moveTo } from './branching';

/**
 * git bisect: binary search through history for the commit that introduced a bug.
 * You mark one commit bad and one good; git checks out the midpoint; you test and
 * mark it; repeat. N commits take about log2(N) steps.
 */

function candidates(repo: Repository): Hash[] {
  const b = repo.bisect!;
  if (!b.bad || !b.good.length) return [];
  const goodSet = repo.reachable(b.good);
  return [...repo.reachable([b.bad])].filter((h) => !goodSet.has(h));
}

function nextStep(ctx: GitContext, repo: Repository): number {
  const b = repo.bisect!;
  if (!b.bad) {
    print(ctx, b.good.length ? 'status: waiting for bad commit, 1 good commit known' : 'status: waiting for both good and bad commits');
    return 0;
  }
  if (!b.good.length) {
    print(ctx, 'status: waiting for good commit(s), bad commit known');
    return 0;
  }
  const cands = candidates(repo);
  const testable = cands.filter((h) => h !== b.bad && !b.skipped.includes(h));
  if (!testable.length) {
    const bad = b.bad;
    const co = repo.objects.commit(bad);
    const ps = co.parents;
    const lines = [`${bad} is the first bad commit`, ...commitHeader(repo, bad, { decorate: false }), ''];
    if (ps.length <= 1) lines.push(...formatStat(repo, diffFileMaps(ps.length ? repo.commitFiles(ps[0]) : new Map(), repo.commitFiles(bad))));
    print(ctx, ...lines);
    b.log.push(`# first bad commit: [${bad}] ${subject(co.message)}`);
    ctx.world.emit({ type: 'bisect', stage: 'found', commit: bad });
    return 0;
  }
  // Choose the commit that splits the candidates most evenly.
  const set = new Set(cands);
  let best = testable[0];
  let bestScore = -1;
  for (const h of testable) {
    let n = 0;
    for (const x of repo.reachable([h])) if (set.has(x)) n++;
    const score = Math.min(n, cands.length - n);
    if (score > bestScore) {
      bestScore = score;
      best = h;
    }
  }
  const left = Math.floor((cands.length - 1) / 2);
  const steps = Math.max(0, Math.floor(Math.log2(Math.max(1, left))) + (left > 0 ? 1 : 0) - 1);
  const saved = ctx.out.length;
  moveTo(ctx, repo, { branch: null, target: best, label: shortHash(best) });
  ctx.out.length = saved;
  print(
    ctx,
    `Bisecting: ${plural(left, 'revision')} left to test after this (roughly ${plural(steps, 'step')})`,
    `[${best}] ${subject(repo.objects.commit(best).message)}`,
  );
  ctx.world.emit({ type: 'bisect', stage: 'step', commit: best });
  return 0;
}

export async function cmdBisect(ctx: GitContext, argv: string[]): Promise<number> {
  const repo = requireRepo(ctx);
  const [sub, ...rest] = argv;
  const need = () => {
    if (!repo.bisect) throw failure('You need to start by "git bisect start"\n\nDo you want me to do it for you [Y/n]? n', 1);
    return repo.bisect;
  };

  switch (sub) {
    case 'start': {
      if (repo.bisect) {
        // Restart
        repo.bisect = null;
      }
      const head = repo.headHash();
      if (!head) throw fatal('bad HEAD - I need a HEAD');
      repo.bisect = { originalHead: { ...repo.head } as Repository['head'], good: [], bad: null, skipped: [], log: ['git bisect start'] };
      const [badSpec, ...goodSpecs] = rest.filter((r) => r !== '--');
      if (badSpec) repo.bisect.bad = revParseCommit(repo, badSpec);
      for (const g of goodSpecs) repo.bisect.good.push(revParseCommit(repo, g));
      ctx.world.emit({ type: 'bisect', stage: 'start' });
      return nextStep(ctx, repo);
    }
    case 'bad':
    case 'new': {
      const b = need();
      b.bad = revParseCommit(repo, rest[0] ?? 'HEAD');
      b.log.push(`git bisect bad ${b.bad}`);
      return nextStep(ctx, repo);
    }
    case 'good':
    case 'old': {
      const b = need();
      const specs = rest.length ? rest : ['HEAD'];
      for (const s of specs) b.good.push(revParseCommit(repo, s));
      b.log.push(`git bisect good ${specs.join(' ')}`);
      return nextStep(ctx, repo);
    }
    case 'skip': {
      const b = need();
      b.skipped.push(revParseCommit(repo, rest[0] ?? 'HEAD'));
      return nextStep(ctx, repo);
    }
    case 'reset': {
      if (!repo.bisect) {
        print(ctx, 'We are not bisecting.');
        return 0;
      }
      const oh = repo.bisect.originalHead;
      repo.bisect = null;
      if (oh.kind === 'branch') {
        const target = repo.branchHash(oh.name)!;
        const prev = repo.headHash()!;
        const saved = ctx.out.length;
        moveTo(ctx, repo, { branch: oh.name, target, label: oh.name });
        ctx.out.length = saved;
        print(ctx, `Previous HEAD position was ${shortHash(prev)} ${subject(repo.objects.commit(prev).message)}`, `Switched to branch '${oh.name}'`);
      } else {
        moveTo(ctx, repo, { branch: null, target: oh.hash, label: shortHash(oh.hash) });
      }
      ctx.world.emit({ type: 'bisect', stage: 'reset' });
      return 0;
    }
    case 'log': {
      print(ctx, ...need().log);
      return 0;
    }
    case 'run': {
      const b = need();
      const runner = ctx.world.testRunner;
      if (!runner) throw fatal('no test command available in this repo (try `npm test` by hand first)');
      print(ctx, `running '${rest.join(' ') || 'npm test'}'`);
      for (let i = 0; i < 64; i++) {
        const r = runner(repo);
        print(ctx, ...r.output.split('\n'));
        const h = repo.headHash()!;
        if (r.pass) b.good.push(h);
        else b.bad = h;
        const before = candidates(repo).filter((x) => x !== b.bad && !b.skipped.includes(x)).length;
        nextStep(ctx, repo);
        if (!before) break;
      }
      print(ctx, 'bisect found first bad commit');
      return 0;
    }
    case 'visualize':
    case 'view': {
      const { cmdLog } = await import('./history');
      return cmdLog(ctx, ['--oneline', ...candidates(repo)]);
    }
    default:
      print(
        ctx,
        'usage: git bisect [help|start|bad|good|new|old|skip|reset|log|run]',
        '',
        'git bisect start [<bad> [<good>...]]   start a bisect session',
        'git bisect bad [<rev>]                  mark <rev> (default HEAD) as bad',
        'git bisect good [<rev>...]              mark <rev>... (default HEAD) as good',
        'git bisect skip [<rev>]                 this commit can\'t be tested',
        'git bisect reset                        finish and return to your branch',
        'git bisect run <cmd>                    let <cmd> decide good/bad automatically',
      );
      return sub ? 1 : 0;
  }
}

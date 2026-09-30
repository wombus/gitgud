import type { Level } from '../types';
import { level01 } from './01-first-day';
import { level02 } from './02-the-typo';
import { level03 } from './03-branch-out';
import { level04 } from './04-pull-request';
import { level05 } from './05-merge-conflict';
import { level06 } from './06-hotfix-stash';
import { level07 } from './07-revert';
import { level08 } from './08-cherry-pick';
import { level09 } from './09-rebase';
import { level10 } from './10-squash';
import { level11 } from './11-reflog';
import { level12 } from './12-secrets';
import { level13 } from './13-bisect';
import { level14 } from './14-friday-release';

/** The campaign, in order. Adding a level = writing a file and listing it here. */
export const LEVELS: Level[] = [
  level01,
  level02,
  level03,
  level04,
  level05,
  level06,
  level07,
  level08,
  level09,
  level10,
  level11,
  level12,
  level13,
  level14,
];

export function levelById(id: string): Level | undefined {
  return LEVELS.find((l) => l.id === id);
}

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getMeta, type DB } from '../../src/db/database.js';
import { sweep, topUp } from '../../src/indexing/sweep.js';
import { loadRepoMaps } from '../../src/repos/map.js';
import { REPO_NEW_DIR_KEY, resolveAllSessions } from '../../src/repos/resolve.js';
import { createCorpus, userLine, type Corpus } from '../helpers/corpus.js';

/**
 * A sweep, then the full pass the sweep runs when indexing flagged a new directory (the
 * flag is what this file tests; the sweep itself runs the pass from a later change).
 */
function sweepAndResolve(db: DB): void {
  sweep(db);
  if (getMeta(db, REPO_NEW_DIR_KEY) === undefined) return;
  resolveAllSessions(db);
  db.prepare('DELETE FROM meta WHERE key = ?').run(REPO_NEW_DIR_KEY);
}

function useHost(): void {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.CLAUDE_HISTORY_HOST;
    process.env.CLAUDE_HISTORY_HOST = 'laptop';
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDE_HISTORY_HOST;
    else process.env.CLAUDE_HISTORY_HOST = saved;
  });
}

/**
 * A plain `<dir>/worktrees/<n>` session folds only once something shows `<dir>` is a
 * repository. Whichever is indexed first, it ends up folded; a sweep that brings no new
 * directory flags no full pass.
 */
describe('resolution does not depend on the order directories are first seen', () => {
  useHost();
  let corpus: Corpus;
  beforeEach(() => { corpus = createCorpus(); });
  afterEach(() => corpus.cleanup());

  const repo = (id: string) => corpus.open().prepare('SELECT repo, repo_root FROM sessions WHERE id = ?').get(id);
  const session = (project: string, id: string, cwd: string) =>
    corpus.write(corpus.sessionPath(project, id), [userLine('hi', { cwd, sessionId: id })]);

  it('folds a worktree session indexed before any session in its repository', () => {
    session('-work-d-worktrees-n', 'wt', '/work/d/worktrees/n');
    sweepAndResolve(corpus.open());
    expect(repo('wt')).toEqual({ repo: 'laptop:/work/d/worktrees/n', repo_root: '/work/d/worktrees/n' });

    session('-work-d', 'main', '/work/d');
    sweepAndResolve(corpus.open());
    expect(repo('wt')).toEqual({ repo: 'laptop:/work/d', repo_root: '/work/d' });
  });

  it('folds a worktree session indexed after a session in its repository', () => {
    session('-work-d', 'main', '/work/d');
    sweepAndResolve(corpus.open());
    session('-work-d-worktrees-n', 'wt', '/work/d/worktrees/n');
    sweepAndResolve(corpus.open());
    expect(repo('wt')).toEqual({ repo: 'laptop:/work/d', repo_root: '/work/d' });
  });

  it('folds both when they arrive in the same sweep, in either order', () => {
    session('-work-d-worktrees-n', 'wt', '/work/d/worktrees/n');
    session('-work-d', 'main', '/work/d');
    session('-work-e', 'e-main', '/work/e');
    session('-work-e-worktrees-m', 'e-wt', '/work/e/worktrees/m');
    sweepAndResolve(corpus.open());
    expect(repo('wt')).toEqual({ repo: 'laptop:/work/d', repo_root: '/work/d' });
    expect(repo('e-wt')).toEqual({ repo: 'laptop:/work/e', repo_root: '/work/e' });
  });

  it('flags the full pass from a top-up that brought a new directory', () => {
    session('-work-d-worktrees-n', 'wt', '/work/d/worktrees/n');
    const db = corpus.open();
    sweepAndResolve(db);
    session('-work-d', 'main', '/work/d');
    topUp(db, 10_000);
    expect(getMeta(db, REPO_NEW_DIR_KEY)).toBeDefined();
    sweepAndResolve(db);
    expect(repo('wt')).toEqual({ repo: 'laptop:/work/d', repo_root: '/work/d' });
  });

  it('flags no full pass when a sweep brings only directories seen before', () => {
    session('-work-d', 'main', '/work/d');
    const db = corpus.open();
    sweepAndResolve(db);
    db.prepare("UPDATE sessions SET repo = 'sentinel'").run(); // a full pass would rewrite it
    session('-work-d', 'main-2', '/work/d');
    sweep(db);
    expect(getMeta(db, REPO_NEW_DIR_KEY)).toBeUndefined();
    expect(repo('main')).toMatchObject({ repo: 'sentinel' });
    expect(repo('main-2')).toMatchObject({ repo: 'laptop:/work/d' });
  });

  it('resolves a session again when its unknown host is filled', () => {
    const path = corpus.write(corpus.sessionPath('-work-d', 'old'), [userLine('hi', { cwd: '/work/d', sessionId: 'old' })]);
    const db = corpus.open();
    sweepAndResolve(db);
    // as a session indexed before hosts were recorded, then resolved by a full pass
    db.prepare("UPDATE sessions SET host = '', repo = '/work/d'").run();
    corpus.append(path, [userLine('again', { cwd: '/work/d', sessionId: 'old' })]);
    sweep(db);
    expect(db.prepare("SELECT host FROM sessions WHERE id = 'old'").pluck().get()).toBe('laptop');
    expect(repo('old')).toEqual({ repo: 'laptop:/work/d', repo_root: '/work/d' });
    expect(getMeta(db, REPO_NEW_DIR_KEY)).toBeDefined();
  });

  it('flags the full pass for a directory first seen with git evidence on this host only', () => {
    session('-work-d', 'main', '/work/d');
    const db = corpus.open();
    sweepAndResolve(db);
    process.env.CLAUDE_HISTORY_HOST = 'desktop';
    session('-work-d', 'desk-main', '/work/d');
    sweep(db);
    expect(getMeta(db, REPO_NEW_DIR_KEY)).toBeDefined();
    expect(repo('desk-main')).toEqual({ repo: 'desktop:/work/d', repo_root: '/work/d' });
  });
});

describe('strong evidence only', () => {
  useHost();
  let corpus: Corpus;
  beforeEach(() => { corpus = createCorpus(); });
  afterEach(() => corpus.cleanup());
  const write = (project: string, id: string, cwd: string, gitBranch = 'main') =>
    corpus.write(corpus.sessionPath(project, id), [userLine('hi', { cwd, sessionId: id, gitBranch })]);
  const repo = (id: string) => corpus.open().prepare('SELECT repo FROM sessions WHERE id = ?').pluck().get(id);

  it('does not fold a folder-of-repositories worktree into the folder a branchless session ran in', () => {
    write('-home-me-src', 'folder', '/home/me/src', '');
    write('-home-me-src--worktrees-config-history', 'wt', '/home/me/src/.worktrees/config-history');
    sweepAndResolve(corpus.open());
    expect(repo('wt')).toBe('laptop:/home/me/src/.worktrees/config-history');
    expect(repo('folder')).toBe('laptop:/home/me/src');
  });

  it('folds a per-repository .worktrees folder on branch evidence', () => {
    write('-home-me-src-app', 'main', '/home/me/src/app');
    write('-home-me-src-app--worktrees-batch-service', 'wt', '/home/me/src/app/.worktrees/batch-service');
    sweepAndResolve(corpus.open());
    expect(repo('wt')).toBe('laptop:/home/me/src/app');
  });

  it('folds a per-repository .worktrees folder on map evidence alone', () => {
    const mapDir = join(corpus.dataDir, 'repo-map');
    mkdirSync(mapDir, { recursive: true });
    writeFileSync(join(mapDir, 'laptop.jsonl'), JSON.stringify({ dir: '/w/hf', root: '/w/hf', remote: null, at: 1 }) + '\n');
    const db = corpus.open();
    loadRepoMaps(db, mapDir, 'laptop');
    write('-w-hf--worktrees-x', 'wt', '/w/hf/.worktrees/x', '');
    sweepAndResolve(db);
    expect(repo('wt')).toBe('laptop:/w/hf');
  });

  it("does not fold on another host's map evidence", () => {
    const mapDir = join(corpus.dataDir, 'repo-map');
    mkdirSync(mapDir, { recursive: true });
    writeFileSync(join(mapDir, 'desktop.jsonl'), JSON.stringify({ dir: '/w/hf', root: '/w/hf', remote: null, at: 1 }) + '\n');
    const db = corpus.open();
    loadRepoMaps(db, mapDir, 'desktop');
    write('-w-hf--worktrees-x', 'wt', '/w/hf/.worktrees/x', '');
    sweepAndResolve(db);
    expect(repo('wt')).toBe('laptop:/w/hf/.worktrees/x');
  });

  it('does not fold ~/.cache/route/worktrees/<n> into ~/.cache/route on a bare session there', () => {
    write('-home-u--cache-route', 'route', '/home/u/.cache/route', '');
    write('-home-u--cache-route-worktrees-x', 'wt', '/home/u/.cache/route/worktrees/x');
    sweepAndResolve(corpus.open());
    expect(repo('wt')).toBe('laptop:/home/u/.cache/route/worktrees/x');
  });

  it('folds <repo>/.claude/worktrees/<n>/src into <repo> with no evidence', () => {
    write('-r--claude-worktrees-x-src', 'wt', '/r/.claude/worktrees/x/src', '');
    sweepAndResolve(corpus.open());
    expect(repo('wt')).toBe('laptop:/r');
  });

  it('does not let a subdirectory session capture a .worktrees sibling by name', () => {
    write('-w-ap', 'main', '/w/ap');
    write('-w-ap-android', 'sub', '/w/ap/android');
    write('-w-ap--worktrees-android-ui-manifest', 'wt', '/w/ap/.worktrees/android-ui-manifest');
    write('-w--worktrees-api-gateway-fix', 'wt2', '/w/.worktrees/api-gateway-fix');
    write('-w-api', 'api', '/w/api');
    sweepAndResolve(corpus.open());
    expect(repo('wt')).toBe('laptop:/w/ap');
    expect(repo('wt2')).toBe('laptop:/w/.worktrees/api-gateway-fix');
  });
});

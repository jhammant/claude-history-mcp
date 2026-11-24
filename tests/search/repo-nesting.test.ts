import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../../src/db/database.js';
import { SearchEngine } from '../../src/search/search-engine.js';
import { matchProjects, reposForProjectFilter } from '../../src/tools/project-match.js';
import { sweep } from '../../src/indexing/sweep.js';
import { createCorpus, userLine, type Corpus } from '../helpers/corpus.js';

interface Row { id: string; project: string; cwd: string | null; repo: string | null; root: string | null; host?: string }

/**
 * Index a real transcript per session, then set the repository columns by hand (and clear
 * cwd_git, so git evidence exists only where a case adds it) so each case
 * states exactly the (host, repo, repo_root) it is about.
 */
function build(corpus: Corpus, rows: Row[]): DB {
  for (const r of rows) {
    corpus.write(corpus.sessionPath(r.project, r.id), [
      userLine('gearbox question', { cwd: r.cwd ?? '/unused', sessionId: r.id, timestamp: '2026-10-01T09:00:00Z' }),
    ]);
  }
  const db = corpus.open();
  sweep(db);
  const set = db.prepare('UPDATE sessions SET cwd = ?, repo = ?, repo_root = ?, host = ?, cwd_git = 0 WHERE id = ?');
  for (const r of rows) set.run(r.cwd, r.repo, r.root, r.host ?? 'laptop', r.id);
  return db;
}

const APP = 'git.example.org/me/app';
const LIB = 'git.example.org/me/lib';

const NESTED: Row[] = [
  { id: 'app-1', project: '-home-me-dev-app', cwd: '/home/me/dev/app', repo: APP, root: '/home/me/dev/app' },
  { id: 'lib-nested', project: '-home-me-dev-app--claude-worktrees-lib-skin', cwd: '/home/me/dev/app/.claude/worktrees/lib-skin', repo: LIB, root: '/x/Lib' },
  { id: 'lib-main', project: '-x-Lib', cwd: '/x/Lib', repo: LIB, root: '/x/Lib' },
];

describe('a repository nested in another repository tree', () => {
  let corpus: Corpus;
  let db: DB;
  beforeEach(() => { corpus = createCorpus(); db = build(corpus, NESTED); });
  afterEach(() => corpus.cleanup());

  const ids = (filter: string) => new SearchEngine(db).search('gearbox', { project: filter }).hits.map((h) => h.sessionId).sort();

  it.each(['/home/me/dev/app', '-home-me-dev-app', 'dev/app'])(
    'filter %s reaches the nested session but not the other repository sessions',
    (filter) => {
      expect(ids(filter)).toEqual(['app-1', 'lib-nested']);
      expect(reposForProjectFilter(db, filter)).toEqual([APP]);
      const projects = matchProjects(db, filter);
      expect(projects).not.toContain('-x-Lib');
      expect(projects).toContain('-home-me-dev-app--claude-worktrees-lib-skin');
    },
  );

  it('the bare folder name does the same', () => {
    expect(ids('app')).toEqual(['app-1', 'lib-nested']);
    expect(matchProjects(db, 'app')).not.toContain('-x-Lib');
  });

  it('a repository named by the filter is still included', () => {
    expect(ids('lib')).toEqual(['lib-main', 'lib-nested']);
  });

  it('a root on another host never disqualifies a session', () => {
    db.prepare("UPDATE sessions SET host = 'server' WHERE id = 'app-1'").run();
    expect(reposForProjectFilter(db, '/home/me/dev/app').sort()).toEqual([APP, LIB].sort());
  });
});

describe('filters that still expand', () => {
  let corpus: Corpus;
  beforeEach(() => { corpus = createCorpus(); });
  afterEach(() => corpus.cleanup());

  it('a symlinked path still reaches the repository elsewhere', () => {
    const db = build(corpus, [
      { id: 'via-link', project: '-home-me-link-app-sub', cwd: '/home/me/link/app/sub', repo: APP, root: '/data/app' },
      { id: 'real', project: '-data-app', cwd: '/data/app', repo: APP, root: '/data/app' },
      { id: 'unrelated', project: '-x-lib', cwd: '/x/lib', repo: LIB, root: '/x/lib' },
    ]);
    expect(new SearchEngine(db).search('gearbox', { project: '/home/me/link/app' }).hits.map((h) => h.sessionId).sort()).toEqual(['real', 'via-link']);
    expect(matchProjects(db, '/home/me/link/app').sort()).toEqual(['-data-app', '-home-me-link-app-sub']);
  });

  it('a parent folder reaches every repository beneath it, including a path-only one at the folder', () => {
    const db = build(corpus, [
      { id: 'a', project: '-home-me-dev-app', cwd: '/home/me/dev/app', repo: APP, root: '/home/me/dev/app' },
      { id: 'a-wt', project: '-w-app', cwd: '/w/app', repo: APP, root: '/home/me/dev/app' },
      { id: 'l', project: '-home-me-dev-lib', cwd: '/home/me/dev/lib', repo: LIB, root: '/home/me/dev/lib' },
      { id: 'folder', project: '-home-me-dev', cwd: '/home/me/dev', repo: 'laptop:/home/me/dev', root: '/home/me/dev' },
      { id: 'other', project: '-q', cwd: '/q', repo: 'laptop:/q', root: '/q' },
    ]);
    expect(reposForProjectFilter(db, '/home/me/dev').sort()).toEqual([APP, LIB, 'laptop:/home/me/dev'].sort());
    expect(new SearchEngine(db).search('gearbox', { project: '/home/me/dev' }).hits.map((h) => h.sessionId).sort()).toEqual(['a', 'a-wt', 'folder', 'l']);
    expect(matchProjects(db, '/home/me/dev')).toContain('-w-app');
  });

  it('a path-only parent folder does not stop a symlinked repository reaching its other directories', () => {
    const db = build(corpus, [
      { id: 'folder', project: '-home-me-dev', cwd: '/home/me/dev', repo: 'laptop:/home/me/dev', root: '/home/me/dev' },
      { id: 'via-link', project: '-home-me-dev-app-link', cwd: '/home/me/dev/app-link', repo: APP, root: '/data/app' },
      { id: 'real', project: '-data-app', cwd: '/data/app', repo: APP, root: '/data/app' },
    ]);
    for (const filter of ['/home/me/dev', 'dev']) {
      expect(reposForProjectFilter(db, filter)).toContain(APP);
      expect(matchProjects(db, filter)).toContain('-data-app');
      expect(new SearchEngine(db).search('gearbox', { project: filter }).hits.map((h) => h.sessionId)).toContain('real');
    }
  });

  it('an encoded filter matches a root containing dots or underscores', () => {
    const db = build(corpus, [
      { id: 'app-1', project: '-home-me-my-app', cwd: '/home/me/my.app', repo: APP, root: '/home/me/my.app' },
      { id: 'lib-nested', project: '-home-me-my-app--claude-worktrees-lib-skin', cwd: '/home/me/my.app/.claude/worktrees/lib-skin', repo: LIB, root: '/x/Lib' },
      { id: 'lib-main', project: '-x-Lib', cwd: '/x/Lib', repo: LIB, root: '/x/Lib' },
    ]);
    expect(reposForProjectFilter(db, '-home-me-my-app')).toEqual([APP]);
    expect(matchProjects(db, '-home-me-my-app')).not.toContain('-x-Lib');
  });
});

describe('a repository nested in a repository known only by its path', () => {
  let corpus: Corpus;
  beforeEach(() => { corpus = createCorpus(); });
  afterEach(() => corpus.cleanup());

  const ROOT_KEY = 'laptop:/home/me/dev/app';
  const rows: Row[] = [
    { id: 'app-1', project: '-home-me-dev-app', cwd: '/home/me/dev/app', repo: ROOT_KEY, root: '/home/me/dev/app' },
    { id: 'lib-nested', project: '-home-me-dev-app--claude-worktrees-lib-skin', cwd: '/home/me/dev/app/.claude/worktrees/lib-skin', repo: LIB, root: '/x/Lib' },
    { id: 'lib-main', project: '-x-Lib', cwd: '/x/Lib', repo: LIB, root: '/x/Lib' },
  ];

  it('is a containing repository when a session saw git at its root', () => {
    const db = build(corpus, rows);
    db.prepare("UPDATE sessions SET cwd_git = 1 WHERE id = 'app-1'").run();
    expect(reposForProjectFilter(db, '/home/me/dev/app')).toEqual([ROOT_KEY]);
    expect(matchProjects(db, '/home/me/dev/app')).not.toContain('-x-Lib');
  });

  it('is a containing repository when the pushed map names its root', () => {
    const db = build(corpus, rows);
    db.prepare("INSERT INTO repo_map(host, dir, root, remote, at) VALUES ('laptop', '/home/me/dev/app', '/home/me/dev/app', NULL, 1)").run();
    expect(reposForProjectFilter(db, '/home/me/dev/app')).toEqual([ROOT_KEY]);
  });

  it('is not one on another host evidence alone', () => {
    const db = build(corpus, rows);
    db.prepare("INSERT INTO repo_map(host, dir, root, remote, at) VALUES ('desktop', '/home/me/dev/app', '/home/me/dev/app', NULL, 1)").run();
    expect(reposForProjectFilter(db, '/home/me/dev/app').sort()).toEqual([LIB, ROOT_KEY].sort());
  });

  it('a plain folder with no git evidence still does not contain it', () => {
    const db = build(corpus, rows);
    expect(reposForProjectFilter(db, '/home/me/dev/app').sort()).toEqual([LIB, ROOT_KEY].sort());
  });
});


describe('a project filter with a trailing slash', () => {
  let corpus: Corpus;
  let db: DB;
  beforeEach(() => { corpus = createCorpus(); db = build(corpus, NESTED); });
  afterEach(() => corpus.cleanup());

  it.each(['/home/me/dev/app/', '/home/me/dev/app//'])('%s finds what the same path without it finds', (filter) => {
    expect(new SearchEngine(db).search('gearbox', { project: filter }).hits.map((h) => h.sessionId).sort()).toEqual(['app-1', 'lib-nested']);
    expect(reposForProjectFilter(db, filter)).toEqual([APP]);
    expect(matchProjects(db, filter).sort()).toEqual(matchProjects(db, '/home/me/dev/app').sort());
    expect(matchProjects(db, filter)).toContain('-home-me-dev-app');
  });

  it('a bare slash stays as it is', () => {
    expect(new SearchEngine(db).search('gearbox', { project: '/' }).hits).toHaveLength(3);
  });
});

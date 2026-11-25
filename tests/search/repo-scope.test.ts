import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sweep } from '../../src/indexing/sweep.js';
import { SearchEngine } from '../../src/search/search-engine.js';
import { handleListProjects } from '../../src/tools/list-projects.js';
import { matchProjects } from '../../src/tools/project-match.js';
import {
  assistantText, createCorpus, piAssistant, piSession, piText, piUser, rolloutMessage, rolloutMeta, userLine, type Corpus,
} from '../helpers/corpus.js';
import { useHost } from '../helpers/host.js';

const CODEX = '0199bbbb-0000-7000-8000-000000000001';
const PI = '0a1b2c3d-0000-4000-8000-0000000000aa';
const REMOTE = 'https://git.example.org/team/app.git';

/**
 * One repository in three places: Claude in the checkout, Codex in an out-of-repo worktree
 * that the pushed map ties to it, pi in a Claude-style worktree under it. Plus an unrelated
 * project.
 */
describe('one repository across directories and sources', () => {
  useHost();
  let corpus: Corpus;

  beforeEach(() => {
    corpus = createCorpus();
    mkdirSync(join(corpus.dataDir, 'repo-map'), { recursive: true });
    writeFileSync(join(corpus.dataDir, 'repo-map', 'laptop.jsonl'), [
      { dir: '/work/app', root: '/work/app', remote: REMOTE, at: 1 },
      { dir: '/work/wt-x', root: '/work/app', remote: REMOTE, at: 2 },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n');
    corpus.write(corpus.sessionPath('-work-app', 'claude-1'), [
      userLine('gearbox question in the checkout', { cwd: '/work/app', sessionId: 'claude-1', timestamp: '2026-10-01T09:00:00Z' }),
      assistantText('gearbox answer', { cwd: '/work/app', sessionId: 'claude-1', timestamp: '2026-10-01T09:01:00Z' }),
    ]);
    corpus.write(corpus.rolloutPath('2026-10-02', CODEX), [
      rolloutMeta(CODEX, { cwd: '/work/wt-x', repositoryUrl: REMOTE, timestamp: '2026-10-02T09:00:00Z' }),
      rolloutMessage('user', 'gearbox question in the worktree', { timestamp: '2026-10-02T09:00:00Z' }),
    ]);
    corpus.write(corpus.piPath('--work-app-.claude-worktrees-a--', PI), [
      piSession(PI, { cwd: '/work/app/.claude/worktrees/a', timestamp: '2026-10-03T09:00:00Z' }),
      piUser('gearbox question in the claude worktree', { timestamp: '2026-10-03T09:00:00Z' }),
      piAssistant([piText('gearbox reply')], { timestamp: '2026-10-03T09:01:00Z' }),
    ]);
    corpus.write(corpus.sessionPath('-work-other', 'other-1'), [
      userLine('gearbox question elsewhere', { cwd: '/work/other', sessionId: 'other-1', timestamp: '2026-09-01T09:00:00Z' }),
    ]);
    sweep(corpus.open());
  });
  afterEach(() => corpus.cleanup());

  const ALL = ['claude-1', `codex-${CODEX}`, `pi-${PI}`];

  it('resolves all three sessions to one repository', () => {
    const rows = corpus.open().prepare("SELECT id, repo FROM sessions WHERE id != 'other-1' ORDER BY id").all() as Array<{ repo: string }>;
    expect(new Set(rows.map((r) => r.repo))).toEqual(new Set(['git.example.org/team/app']));
  });

  it('matchProjects reaches every directory of the repository, by name or by one of its paths', () => {
    const db = corpus.open();
    const projectsOf = (ids: string[]) =>
      (db.prepare(`SELECT DISTINCT project FROM sessions WHERE id IN (${ids.map(() => '?').join(',')})`).pluck().all(...ids) as string[]).sort();
    expect(matchProjects(db, 'app').sort()).toEqual(projectsOf(ALL));
    expect(matchProjects(db, 'APP').sort()).toEqual(projectsOf(ALL));
    expect(matchProjects(db, '/work/wt-x').sort()).toEqual(projectsOf(ALL));
    expect(matchProjects(db, 'git.example.org/team/app').sort()).toEqual(projectsOf(ALL));
    // Unchanged: an unrelated project, and nothing at all.
    expect(matchProjects(db, 'other')).toEqual(['-work-other']);
    expect(matchProjects(db, 'nothing-like-this')).toEqual([]);
  });

  it('project:<repo name> in search returns the sessions of every directory and source', () => {
    const engine = new SearchEngine(corpus.open());
    expect(engine.search('gearbox project:app').hits.map((h) => h.sessionId).sort()).toEqual([...ALL].sort());
    expect(engine.search('gearbox', { project: 'wt-x' }).hits.map((h) => h.sessionId).sort()).toEqual([...ALL].sort());
    expect(engine.search('gearbox project:other').hits.map((h) => h.sessionId)).toEqual(['other-1']);
    expect(engine.search('gearbox project:nothing-like-this').hits).toEqual([]);
  });

  it('list_projects gives the repository one row with its member directories and no remote', () => {
    const text = handleListProjects(corpus.open(), {});
    expect(text).toContain('2 projects with conversation history:');
    expect(text).toMatch(/^- app — 3 sessions, \d+ messages \(1 Claude, 1 Codex, 1 pi\)$/m);
    expect(text).toContain('  Directories: /work/app/.claude/worktrees/a, /work/wt-x, /work/app');
    expect(text).toMatch(/^- other — 1 sessions/m);
    expect(text).not.toContain('://');
    expect(text).not.toContain('git.example.org');
    // Most recent activity first.
    expect(text.indexOf('- app')).toBeLessThan(text.indexOf('- other'));
    // The filter matches the repository name and member directories.
    expect(handleListProjects(corpus.open(), { query: 'wt-x' })).toContain('- app — 3 sessions');
  });
});

describe('a folder of repositories with its own worktree folder', () => {
  useHost();
  let corpus: Corpus;
  beforeEach(() => {
    corpus = createCorpus();
    // The folder itself is a working directory, with no git branch: not a repository.
    corpus.write(corpus.sessionPath('-home-me-src', 'folder'), [
      userLine('gearbox in the folder', { cwd: '/home/me/src', sessionId: 'folder', gitBranch: '', timestamp: '2026-10-01T09:00:00Z' }),
    ]);
    corpus.write(corpus.sessionPath('-home-me-src--worktrees-claude-config-history', 'wt'), [
      userLine('gearbox in the worktree', { cwd: '/home/me/src/.worktrees/claude-config-history', sessionId: 'wt', timestamp: '2026-10-02T09:00:00Z' }),
    ]);
    sweep(corpus.open());
  });
  afterEach(() => corpus.cleanup());

  it('keeps the worktree out of the folder in matchProjects, and list_projects', () => {
    const db = corpus.open();
    // Two repositories, so naming the worktree's never reaches the folder's sessions. (Text that
    // is a substring of both paths matched both before repositories existed, and still does.)
    expect(db.prepare("SELECT id, repo FROM sessions ORDER BY id").all()).toEqual([
      { id: 'folder', repo: 'laptop:/home/me/src' },
      { id: 'wt', repo: 'laptop:/home/me/src/.worktrees/claude-config-history' },
    ]);
    expect(matchProjects(db, 'claude-config-history')).toEqual(['-home-me-src--worktrees-claude-config-history']);
    expect(new SearchEngine(db).search('gearbox project:claude-config-history').hits.map((h) => h.sessionId)).toEqual(['wt']);

    const text = handleListProjects(db, {});
    expect(text).toContain('2 projects with conversation history:');
    expect(text).toMatch(/^- src — 1 sessions/m);
    expect(text).toMatch(/^- claude-config-history — 1 sessions/m);
  });
});

describe('list_projects headings and member cap', () => {
  useHost();
  let corpus: Corpus;
  beforeEach(() => { corpus = createCorpus(); });
  afterEach(() => corpus.cleanup());

  it('tells two repositories of one name apart by path', () => {
    corpus.write(corpus.sessionPath('-work-a-app', 'a'), [userLine('hi', { cwd: '/work/a/app', sessionId: 'a' })]);
    corpus.write(corpus.sessionPath('-work-b-app', 'b'), [userLine('hi', { cwd: '/work/b/app', sessionId: 'b' })]);
    sweep(corpus.open());
    const text = handleListProjects(corpus.open(), {});
    expect(text).toMatch(/^- \/work\/a\/app — 1 sessions/m);
    expect(text).toMatch(/^- \/work\/b\/app — 1 sessions/m);
  });

  it('lists at most five member directories, then how many more', () => {
    const remote = 'https://git.example.org/team/many.git';
    for (let i = 0; i < 7; i++) {
      const u = `0199cccc-0000-7000-8000-00000000000${i}`;
      corpus.write(corpus.rolloutPath('2026-10-01', u), [
        rolloutMeta(u, { cwd: `/work/many-${i}`, repositoryUrl: remote, timestamp: `2026-10-0${i + 1}T09:00:00Z` }),
        rolloutMessage('user', 'hello', { timestamp: `2026-10-0${i + 1}T09:00:00Z` }),
      ]);
    }
    sweep(corpus.open());
    const text = handleListProjects(corpus.open(), {});
    expect(text).toMatch(/^- many — 7 sessions/m);
    expect(text).toContain('  Directories: /work/many-6, /work/many-5, /work/many-4, /work/many-3, /work/many-2 +2 more');
  });
});

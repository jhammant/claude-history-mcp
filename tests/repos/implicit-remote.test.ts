import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../../src/db/database.js';
import { sweep } from '../../src/indexing/sweep.js';
import { repoResolver, resolveAllSessions } from '../../src/repos/resolve.js';
import { useHost } from '../helpers/host.js';
import { createCorpus, piSession, piUser, rolloutMessage, rolloutMeta, rolloutTurn, userLine, type Corpus } from '../helpers/corpus.js';

const U1 = '0199eeee-0000-7000-8000-000000000001';
const U2 = '0199eeee-0000-7000-8000-000000000002';
const P1 = '0199eeee-0000-7000-8000-0000000000a1';
const REMOTE = 'https://example.com/acme/app.git';
const KEY = 'example.com/acme/app';

const NO_GIT = { probeRepos: false };

/**
 * A session with git_remote and cwd_git = 1 is an implicit map row for its own cwd: other
 * sessions of the same host at exactly that cwd take its remote as their repository key.
 */
describe('implicit map rows from a session remote at its own cwd', () => {
  let corpus: Corpus;
  useHost();
  beforeEach(() => { corpus = createCorpus(); });
  afterEach(() => corpus.cleanup());

  const repo = (id: string) => corpus.open().prepare('SELECT repo, repo_root FROM sessions WHERE id = ?').get(id);
  const claude = (project: string, id: string, cwd: string) =>
    corpus.write(corpus.sessionPath(project, id), [userLine('hi', { cwd, sessionId: id })]);
  const codex = (u: string, cwd: string) =>
    corpus.write(corpus.rolloutPath('2026-10-01', u), [rolloutMeta(u, { cwd, repositoryUrl: REMOTE }), rolloutMessage('user', 'hello there')]);
  const repoCount = () => corpus.open().prepare('SELECT count(DISTINCT repo) FROM sessions').pluck().get();

  it('joins a Claude session indexed before the Codex session at the same cwd', () => {
    claude('-w-app', 'c1', '/w/app');
    sweep(corpus.open(), NO_GIT);
    expect(repo('c1')).toEqual({ repo: 'laptop:/w/app', repo_root: '/w/app' });
    codex(U1, '/w/app');
    sweep(corpus.open(), NO_GIT);
    expect(repo('c1')).toEqual({ repo: KEY, repo_root: '/w/app' });
    expect(repo(`codex-${U1}`)).toEqual({ repo: KEY, repo_root: '/w/app' });
    expect(repoCount()).toBe(1);
  });

  it('joins a Claude session indexed after the Codex session at the same cwd', () => {
    codex(U1, '/w/app');
    sweep(corpus.open(), NO_GIT);
    claude('-w-app', 'c1', '/w/app');
    sweep(corpus.open(), NO_GIT);
    expect(repo('c1')).toEqual({ repo: KEY, repo_root: '/w/app' });
    expect(repoCount()).toBe(1);
  });

  it('joins both when they arrive in one sweep', () => {
    claude('-w-app', 'c1', '/w/app');
    codex(U1, '/w/app');
    sweep(corpus.open(), NO_GIT);
    expect(repo('c1')).toMatchObject({ repo: KEY });
    expect(repoCount()).toBe(1);
  });

  it('applies to the exact cwd only, never to a directory below it', () => {
    codex(U1, '/w/app');
    claude('-w-app-sub', 'sub', '/w/app/sub');
    sweep(corpus.open(), NO_GIT);
    expect(repo('sub')).toEqual({ repo: 'laptop:/w/app/sub', repo_root: '/w/app/sub' });
  });

  it('takes nothing from a Codex session whose activity left its header cwd (cwd_git = 0)', () => {
    corpus.write(corpus.rolloutPath('2026-10-01', U2), [
      rolloutMeta(U2, { cwd: '/w/repoA', repositoryUrl: REMOTE }),
      rolloutTurn('/w/folder'),
      rolloutMessage('user', 'hello from the folder'),
    ]);
    claude('-w-folder', 'f1', '/w/folder');
    sweep(corpus.open(), NO_GIT);
    expect(repo('f1')).toEqual({ repo: 'laptop:/w/folder', repo_root: '/w/folder' });
  });

  it('gives a pi session at the same cwd the remote', () => {
    codex(U1, '/w/app');
    corpus.write(corpus.piPath('--w-app--', P1), [piSession(P1, { cwd: '/w/app' }), piUser('hello pi')]);
    sweep(corpus.open(), NO_GIT);
    const pi = corpus.open().prepare("SELECT repo FROM sessions WHERE source = 'pi'").pluck().get();
    expect(pi).toBe(KEY);
  });

  it('does not reach a session indexed from another host at the same cwd', () => {
    claude('-w-app', 'c1', '/w/app');
    sweep(corpus.open(), NO_GIT);
    process.env.CLAUDE_HISTORY_HOST = 'desktop';
    codex(U1, '/w/app');
    sweep(corpus.open(), NO_GIT);
    expect(repo(`codex-${U1}`)).toEqual({ repo: KEY, repo_root: '/w/app' });
    expect(repo('c1')).toEqual({ repo: 'laptop:/w/app', repo_root: '/w/app' });
  });
});

describe('implicit rows in the resolver', () => {
  let dir: string;
  let db: DB;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'history-implicit-'));
    db = openDatabase(join(dir, 'history.db'), { create: true });
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const session = (id: string, cwd: string, remote: string | null, cwdGit: number, end: number | null = null, host = 'laptop') =>
    db.prepare("INSERT INTO sessions(id, project, host, cwd, git_remote, cwd_git, end_time, source) VALUES (?, 'p', ?, ?, ?, ?, ?, 'codex')")
      .run(id, host, cwd, remote, cwdGit, end);
  const resolve = (cwd: string) => repoResolver(db)({ host: 'laptop', cwd, gitRemote: null });

  it('ranks below a real map row, and the most recent remote wins at one cwd, in both paths', () => {
    session('old', '/w/app', 'https://h.example/o/old.git', 1, 100);
    session('new', '/w/app', 'https://h.example/o/new.git', 1, 200);
    session('other-host', '/w/app', 'https://h.example/o/elsewhere.git', 1, 300, 'desktop');
    session('plain', '/w/app', null, 0, 50);
    expect(resolve('/w/app')).toEqual({ key: 'h.example/o/new', name: 'new', root: '/w/app' });
    resolveAllSessions(db);
    expect(db.prepare("SELECT repo FROM sessions WHERE id = 'plain'").pluck().get()).toBe('h.example/o/new');
    db.prepare("INSERT INTO repo_map(host, dir, root, remote, at) VALUES ('laptop', '/w', '/w', 'https://h.example/o/mapped.git', 1)").run();
    expect(resolve('/w/app')?.key).toBe('h.example/o/mapped');
    resolveAllSessions(db);
    expect(db.prepare("SELECT repo FROM sessions WHERE id = 'plain'").pluck().get()).toBe('h.example/o/mapped');
  });

  it('supplies the key only: the root still comes from folding', () => {
    session('wt', '/w/app/.claude/worktrees/x', 'https://h.example/o/app.git', 1, 1);
    expect(resolve('/w/app/.claude/worktrees/x')).toEqual({ key: 'h.example/o/app', name: 'app', root: '/w/app' });
  });
});

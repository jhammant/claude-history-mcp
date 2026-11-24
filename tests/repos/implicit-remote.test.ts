import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getMeta, openDatabase, setMeta, type DB } from '../../src/db/database.js';
import { sweep } from '../../src/indexing/sweep.js';
import { repoResolvedStamp, repoResolver, resolveAllSessions } from '../../src/repos/resolve.js';
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

  describe('a Codex session whose first line runs in another repository (cwd_git = 0)', () => {
    const B_REMOTE = 'https://example.com/acme/b.git';
    const mapRow = () => {
      const mapDir = join(corpus.dataDir, 'repo-map');
      mkdirSync(mapDir, { recursive: true });
      writeFileSync(join(mapDir, 'laptop.jsonl'), JSON.stringify({ dir: '/w/repoB', root: '/w/repoB', remote: B_REMOTE, at: 1 }) + '\n');
    };
    const leftHeader = () => corpus.write(corpus.rolloutPath('2026-10-01', U2), [
      rolloutMeta(U2, { cwd: '/w/repoA', repositoryUrl: REMOTE }),
      rolloutTurn('/w/repoB'),
      rolloutMessage('user', 'hello from repository B'),
    ]);
    const codexRow = () => corpus.open().prepare('SELECT cwd, git_remote, cwd_git, repo, repo_root FROM sessions WHERE id = ?')
      .get(`codex-${U2}`);

    it('is filed under the map row of its cwd, resolved on write', () => {
      mapRow();
      sweep(corpus.open(), NO_GIT); // the map is loaded before the session arrives
      leftHeader();
      sweep(corpus.open(), NO_GIT);
      expect(codexRow()).toEqual({
        cwd: '/w/repoB', git_remote: REMOTE, cwd_git: 0, repo: 'example.com/acme/b', repo_root: '/w/repoB',
      });
    });

    it('is filed under the map row of its cwd by the full pass', () => {
      mapRow();
      leftHeader();
      sweep(corpus.open(), NO_GIT);
      expect(codexRow()).toMatchObject({ repo: 'example.com/acme/b', repo_root: '/w/repoB' });
    });

    it('a session with a remote seen elsewhere is resolved again when git evidence later appears at its cwd', () => {
      mapRow();
      const line = (text: string, cwd: string, extra: Record<string, unknown> = {}) =>
        ({ ...userLine(text, { cwd, sessionId: 's1', gitBranch: '' }), ...extra });
      // git evidence and the same remote already at the cwd: the session's change flags no full pass
      corpus.write(corpus.sessionPath('-w-repoB', 'other'),
        [{ ...userLine('hi', { cwd: '/w/repoB', sessionId: 'other', gitBranch: 'main' }), gitRemote: REMOTE }]);
      const path = corpus.write(corpus.sessionPath('-w-repoB', 's1'), [
        line('start', '/w/repoB'),
        line('elsewhere', '/w/repoA', { gitRemote: REMOTE }),
      ]);
      sweep(corpus.open(), NO_GIT);
      expect(repo('s1')).toEqual({ repo: 'example.com/acme/b', repo_root: '/w/repoB' });
      corpus.append(path, [line('back', '/w/repoB', { gitBranch: 'main' })]);
      sweep(corpus.open(), NO_GIT);
      // as the full pass resolves it: a remote with git evidence at the cwd comes first
      expect(repo('s1')).toEqual({ repo: KEY, repo_root: '/w/repoB' });
    });

    it('keeps its own remote when no map row names its cwd', () => {
      leftHeader();
      sweep(corpus.open(), NO_GIT);
      expect(codexRow()).toMatchObject({ cwd: '/w/repoB', cwd_git: 0, repo: KEY, repo_root: '/w/repoB' });
    });

    const U3 = '0199eeee-0000-7000-8000-000000000003';
    const codexAtB = () => corpus.write(corpus.rolloutPath('2026-10-02', U3), [
      rolloutMeta(U3, { cwd: '/w/repoB', repositoryUrl: B_REMOTE }),
      rolloutMessage('user', 'hello from inside repository B'),
    ]);

    it('takes the remote another session saw at exactly its cwd, resolved on write', () => {
      codexAtB();
      sweep(corpus.open(), NO_GIT);
      leftHeader();
      sweep(corpus.open(), NO_GIT);
      expect(codexRow()).toMatchObject({ cwd: '/w/repoB', cwd_git: 0, repo: 'example.com/acme/b', repo_root: '/w/repoB' });
    });

    it('is resolved again by the full pass when the first git evidence at its cwd brings a remote', () => {
      leftHeader();
      sweep(corpus.open(), NO_GIT);
      expect(codexRow()).toMatchObject({ repo: KEY });
      codexAtB();
      sweep(corpus.open(), NO_GIT);
      expect(codexRow()).toMatchObject({ cwd_git: 0, repo: 'example.com/acme/b', repo_root: '/w/repoB' });
    });

    it('is resolved again on upgrade from a database stamped by the previous resolver order', () => {
      leftHeader();
      codexAtB();
      const db = corpus.open();
      sweep(db, NO_GIT);
      expect(codexRow()).toMatchObject({ repo: 'example.com/acme/b' });
      // what revision 1 (own remote seen elsewhere above the implicit row) stored, and its stamp
      db.prepare('UPDATE sessions SET repo = ? WHERE id = ?').run(KEY, `codex-${U2}`);
      const revision1 = `4:${createHash('sha1').update('1\n\n.worktrees,worktrees').digest('hex').slice(0, 8)}`;
      expect(repoResolvedStamp()).not.toBe(revision1);
      setMeta(db, 'repo_resolved', revision1);
      sweep(db, NO_GIT);
      expect(codexRow()).toMatchObject({ repo: 'example.com/acme/b', repo_root: '/w/repoB' });
      expect(getMeta(db, 'repo_resolved')).toBe(repoResolvedStamp());
    });

    it('is resolved again by the full pass when a remote joins git evidence already at its cwd', () => {
      // git evidence at the cwd (a branch) but no remote: no implicit row yet
      corpus.write(corpus.sessionPath('-w-repoB', 'branch-only'),
        [userLine('hi', { cwd: '/w/repoB', sessionId: 'branch-only', gitBranch: 'main' })]);
      leftHeader();
      sweep(corpus.open(), NO_GIT);
      expect(corpus.open().prepare("SELECT cwd_git FROM sessions WHERE id = 'branch-only'").pluck().get()).toBe(1);
      expect(codexRow()).toMatchObject({ repo: KEY });
      codexAtB();
      sweep(corpus.open(), NO_GIT);
      expect(codexRow()).toMatchObject({ cwd_git: 0, repo: 'example.com/acme/b', repo_root: '/w/repoB' });
    });
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
  const resolve = (cwd: string) => repoResolver(db)({ host: 'laptop', cwd, gitRemote: null, cwdGit: false });

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

import Database from 'better-sqlite3';
import { spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getMeta, openDatabase } from '../../src/db/database.js';
import { rebuild } from '../../src/indexing/rebuild.js';
import { migrate, MIGRATIONS } from '../../src/db/schema.js';
import { sweep, topUp } from '../../src/indexing/sweep.js';
import { useHost } from '../helpers/host.js';
import { createCorpus, rolloutMessage, rolloutMeta, userLine, type Corpus } from '../helpers/corpus.js';

const U1 = '0199aaaa-0000-7000-8000-000000000001';
const NO_GIT = { probeRepos: false };
const hasGit = spawnSync('git', ['--version']).status === 0;
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], {
    cwd, env: GIT_ENV, encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

describe('repository identity through the indexer and the sweep', () => {
  useHost();
  let corpus: Corpus;
  beforeEach(() => { corpus = createCorpus(); });
  afterEach(() => corpus.cleanup());

  const row = (id: string) =>
    corpus.open().prepare('SELECT git_remote, repo, repo_root FROM sessions WHERE id = ?').get(id);

  it('stores a Codex session git remote with credentials stripped, and resolves it', () => {
    corpus.write(corpus.rolloutPath('2026-10-01', U1), [
      rolloutMeta(U1, { cwd: '/work/app', repositoryUrl: 'https://user:tok3n@git.example.org/Team/App.git' }),
      rolloutMessage('user', 'hello there'),
    ]);
    sweep(corpus.open(), NO_GIT);
    expect(row(`codex-${U1}`)).toEqual({
      git_remote: 'https://git.example.org/Team/App.git', repo: 'git.example.org/team/app', repo_root: '/work/app',
    });
    expect(JSON.stringify(corpus.open().prepare('SELECT * FROM sessions').all())).not.toContain('tok3n');
  });

  it('re-resolves an indexed session when a map file appears, without re-reading its transcript', () => {
    const path = corpus.write(corpus.sessionPath('-work-wt', 's1'), [userLine('hi', { cwd: '/work/wt', sessionId: 's1' })]);
    sweep(corpus.open(), NO_GIT);
    const db = corpus.open();
    expect(row('s1')).toMatchObject({ repo: 'laptop:/work/wt' });
    expect(getMeta(db, 'repo_resolved')).toMatch(/^\d+:[0-9a-f]{8}$/);
    const offset = () => db.prepare('SELECT offset FROM files WHERE path = ?').pluck().get(path);
    const before = offset();

    mkdirSync(join(corpus.dataDir, 'repo-map'), { recursive: true });
    writeFileSync(join(corpus.dataDir, 'repo-map', 'box.jsonl'),
      JSON.stringify({ dir: '/work/wt', root: '/work/main', remote: 'https://h.example/o/main.git', at: 5 }) + '\n');
    sweep(db, NO_GIT);

    expect(row('s1')).toEqual({ git_remote: null, repo: 'h.example/o/main', repo_root: '/work/main' });
    expect(offset()).toBe(before);
  });

  it('resolves a session as its file is indexed, by a sweep or a top-up, without the full pass', () => {
    const db = corpus.open();
    sweep(db, NO_GIT); // stamps repo_resolved
    corpus.write(corpus.sessionPath('-work-sw', 's3'), [userLine('hi', { cwd: '/work/sw', sessionId: 's3' })]);
    db.prepare("UPDATE sessions SET repo = 'sentinel'").run(); // a full pass would rewrite it
    sweep(db, NO_GIT);
    expect(row('s3')).toMatchObject({ repo: 'laptop:/work/sw', repo_root: '/work/sw' });

    corpus.write(corpus.sessionPath('-work-up', 's2'), [userLine('hi', { cwd: '/work/up', sessionId: 's2' })]);
    topUp(db, 10_000);
    expect(row('s2')).toMatchObject({ repo: 'laptop:/work/up' });
  });

  it('keeps the stored git_remote across a resumed read', () => {
    const path = corpus.write(corpus.rolloutPath('2026-10-01', U1), [
      rolloutMeta(U1, { cwd: '/work/app', repositoryUrl: 'https://git.example.org/team/app.git' }),
      rolloutMessage('user', 'first'),
    ]);
    sweep(corpus.open(), NO_GIT);
    corpus.append(path, [rolloutMessage('assistant', 'second')]);
    sweep(corpus.open(), NO_GIT);
    expect(row(`codex-${U1}`)).toMatchObject({ git_remote: 'https://git.example.org/team/app.git', repo: 'git.example.org/team/app' });
  });

  it('re-runs the full pass once when the host alias config changes, and not again', () => {
    corpus.write(corpus.rolloutPath('2026-10-01', U1), [
      rolloutMeta(U1, { cwd: '/work/app', repositoryUrl: 'https://internal.example/team/app.git' }),
      rolloutMessage('user', 'hello'),
    ]);
    const db = corpus.open();
    sweep(db, NO_GIT);
    expect(row(`codex-${U1}`)).toMatchObject({ repo: 'internal.example/team/app' });
    process.env.CLAUDE_HISTORY_REPO_HOST_ALIASES = 'internal.example=git.example';
    try {
      sweep(db, NO_GIT);
      expect(row(`codex-${U1}`)).toMatchObject({ repo: 'git.example/team/app' });
      db.prepare("UPDATE sessions SET repo = 'sentinel'").run();
      sweep(db, NO_GIT);
      expect(row(`codex-${U1}`)).toMatchObject({ repo: 'sentinel' });
    } finally {
      delete process.env.CLAUDE_HISTORY_REPO_HOST_ALIASES;
    }
  });

  it('does not run the full pass on an idle sweep that holds a permanently unresolvable session', () => {
    const db = corpus.open();
    db.prepare("INSERT INTO sessions(id, project, source) VALUES ('nocwd', 'p', 'claude')").run();
    corpus.write(corpus.sessionPath('-work-wt', 's1'), [userLine('hi', { cwd: '/work/wt', sessionId: 's1' })]);
    sweep(db, NO_GIT);
    db.prepare("UPDATE sessions SET repo = 'sentinel' WHERE id = 's1'").run();
    sweep(db, NO_GIT);
    expect(row('s1')).toMatchObject({ repo: 'sentinel' });
    expect(row('nocwd')).toMatchObject({ repo: null });
  });

  it('skips the resolve pass on an idle sweep', () => {
    corpus.write(corpus.sessionPath('-work-wt', 's1'), [userLine('hi', { cwd: '/work/wt', sessionId: 's1' })]);
    sweep(corpus.open(), NO_GIT);
    const db = corpus.open();
    db.prepare("UPDATE sessions SET repo = 'sentinel'").run(); // would be rewritten if the pass ran
    sweep(db, NO_GIT);
    expect(row('s1')).toMatchObject({ repo: 'sentinel' });
    db.prepare("DELETE FROM meta WHERE key = 'repo_resolved'").run();
    sweep(db, NO_GIT);
    expect(row('s1')).toMatchObject({ repo: 'laptop:/work/wt' });
  });
});

describe('sweep repository step', () => {
  useHost();
  let corpus: Corpus;
  beforeEach(() => { corpus = createCorpus(); });
  afterEach(() => corpus.cleanup());

  describe.skipIf(!hasGit)('local resolution', () => {
    let tmp: string;
    let repo: string;
    let wt: string;
    beforeEach(() => {
      tmp = realpathSync(mkdtempSync(join(tmpdir(), 'sweep-git-')));
      repo = join(tmp, 'repo');
      wt = join(tmp, 'wt');
      mkdirSync(repo, { recursive: true });
      git(repo, 'init', '-q');
      writeFileSync(join(repo, 'a.txt'), 'a');
      git(repo, 'add', 'a.txt');
      git(repo, 'commit', '-q', '-m', 'init');
      git(repo, 'remote', 'add', 'origin', 'https://example.com/acme/app.git');
      git(repo, 'worktree', 'add', '-q', wt);
      corpus.write(corpus.sessionPath('-wt', 'wt1'), [userLine('hi', { cwd: wt, sessionId: 'wt1' })]);
    });
    afterEach(() => rmSync(tmp, { recursive: true, force: true }));

    const attribution = () => corpus.open().prepare('SELECT repo, repo_root FROM sessions').get();

    it('attributes a worktree session to its repository on the first sweep', () => {
      const stats = sweep(corpus.open());
      expect(stats.repoError).toBeUndefined();
      expect(attribution()).toEqual({ repo: 'example.com/acme/app', repo_root: repo });
    });

    it('keeps the attribution after the worktree is deleted and the index is rebuilt', async () => {
      sweep(corpus.open());
      rmSync(wt, { recursive: true, force: true });
      git(repo, 'worktree', 'prune');
      corpus.open().close();
      await rebuild(join(corpus.dataDir, 'history.db'));
      const db = openDatabase(join(corpus.dataDir, 'history.db'));
      try {
        expect(db.prepare('SELECT repo, repo_root FROM sessions').get()).toEqual({ repo: 'example.com/acme/app', repo_root: repo });
      } finally {
        db.close();
      }
    });
  });

  it('sweeps a schema 3 database before any rebuild', () => {
    mkdirSync(corpus.dataDir, { recursive: true });
    const old = new Database(join(corpus.dataDir, 'history.db'));
    migrate(old, MIGRATIONS.filter((m) => m.version <= 3));
    old.prepare("INSERT INTO sessions(id, project, cwd, source) VALUES ('old', '-work-app', '/work/app', 'claude')").run();
    old.close();
    const db = corpus.open(); // migrates to the current schema
    const stats = sweep(db, NO_GIT);
    expect(stats.repoError).toBeUndefined();
    expect(db.prepare('SELECT host FROM sessions').pluck().get()).toBe(''); // untouched file: still unknown
  });

  it('does not run git from the query-time top-up', () => {
    const bin = mkdtempSync(join(tmpdir(), 'git-stub-'));
    const marker = join(bin, 'ran');
    const savedPath = process.env.PATH;
    try {
      writeFileSync(join(bin, 'git'), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
      chmodSync(join(bin, 'git'), 0o755);
      process.env.PATH = `${bin}:${savedPath}`;
      corpus.write(corpus.sessionPath('-work-up', 's2'), [userLine('hi', { cwd: '/work/up', sessionId: 's2' })]);
      const db = corpus.open();
      expect(topUp(db, 10_000).indexed).toBe(1);
      expect(db.prepare('SELECT count(*) FROM sessions').pluck().get()).toBe(1);
      expect(existsSync(marker)).toBe(false);
    } finally {
      process.env.PATH = savedPath;
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it('reports a repository failure without failing the sweep', () => {
    corpus.write(corpus.sessionPath('-work-wt', 's1'), [userLine('hi', { cwd: '/work/wt', sessionId: 's1' })]);
    const db = corpus.open();
    sweep(db, NO_GIT);
    db.exec('DROP TABLE repo_map'); // the next load has nowhere to write
    mkdirSync(join(corpus.dataDir, 'repo-map'), { recursive: true });
    writeFileSync(join(corpus.dataDir, 'repo-map', 'laptop.jsonl'),
      JSON.stringify({ dir: '/work/wt', root: '/work/main', remote: null, at: 5 }) + '\n');
    const stats = sweep(db, NO_GIT);
    expect(stats.repoError).toMatch(/repo_map/);
    expect(db.prepare('SELECT count(*) FROM messages').pluck().get()).toBe(1);
    expect(getMeta(db, 'last_sweep')).toBeDefined();
  });
});

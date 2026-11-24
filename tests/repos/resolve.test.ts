import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../../src/db/database.js';
import {
  distinctNames, foldWorktreePath, lastSegment, pathKey, pathKeyHost, repoName, repoResolvedStamp, repoResolver, resolveAllSessions,
} from '../../src/repos/resolve.js';

describe('foldWorktreePath', () => {
  it.each([
    ['/w/app/.claude/worktrees/feat-x', '/w/app'],
    ['/w/app/.claude/worktrees/feat-x/src/deep', '/w/app'],
    // R2 needs evidence: with none, .worktrees and worktrees stay unfolded
    ['/w/app/.worktrees/fix', '/w/app/.worktrees/fix'],
    ['/w/app/.worktrees/fix/sub', '/w/app/.worktrees/fix/sub'],
    ['/r/.claude/worktrees/x/src', '/r'],
    ['/srv/worktrees/a/src', '/srv/worktrees/a/src'],
    ['/home/u/.cache/route/worktrees/x', '/home/u/.cache/route/worktrees/x'],
    ['/', '/'],
    ['/w/app/', '/w/app'],
    ['/w/app', '/w/app'],
    ['/w/worktrees', '/w/worktrees'],
  ])('%s -> %s', (input, expected) => {
    expect(foldWorktreePath(input)).toBe(expected);
  });

  it('folds only the configured container names', () => {
    expect(foldWorktreePath('/r/wt/x', () => true, ['wt'])).toBe('/r');
    expect(foldWorktreePath('/r/worktrees/x', () => true, ['wt'])).toBe('/r/worktrees/x');
    expect(foldWorktreePath('/r/.claude/worktrees/x/sub', undefined, [])).toBe('/r');
  });

  it('turns pattern folding off with no container names, and treats names literally', () => {
    expect(foldWorktreePath('/r/worktrees/x', () => true, [])).toBe('/r/worktrees/x');
    expect(foldWorktreePath('/r/.worktrees/x', () => true, [])).toBe('/r/.worktrees/x');
    // a regex metacharacter in a name matches only itself
    expect(foldWorktreePath('/r/wtXs/x', () => true, ['wt.s'])).toBe('/r/wtXs/x');
    expect(foldWorktreePath('/r/wt.s/x', () => true, ['wt.s'])).toBe('/r');
  });

  it('defaults to the configured CLAUDE_HISTORY_WORKTREE_DIRS', () => {
    const saved = process.env.CLAUDE_HISTORY_WORKTREE_DIRS;
    try {
      process.env.CLAUDE_HISTORY_WORKTREE_DIRS = 'trees';
      expect(foldWorktreePath('/r/trees/x', () => true)).toBe('/r');
      expect(foldWorktreePath('/r/worktrees/x', () => true)).toBe('/r/worktrees/x');
      process.env.CLAUDE_HISTORY_WORKTREE_DIRS = '';
      expect(foldWorktreePath('/r/.worktrees/x', () => true)).toBe('/r/.worktrees/x');
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_HISTORY_WORKTREE_DIRS;
      else process.env.CLAUDE_HISTORY_WORKTREE_DIRS = saved;
    }
  });
});

describe('foldWorktreePath with repository evidence', () => {
  const known = new Set(['/home/me/src/app']);
  const isRepo = (d: string) => known.has(d);
  it('folds plain and hidden worktrees only under a known repository directory', () => {
    expect(foldWorktreePath('/home/me/src/app/.worktrees/batch-service', isRepo)).toBe('/home/me/src/app');
    expect(foldWorktreePath('/home/me/src/app/worktrees/k2', isRepo)).toBe('/home/me/src/app');
    expect(foldWorktreePath('/home/me/src/app/worktrees/k2/src/x', isRepo)).toBe('/home/me/src/app');
    expect(foldWorktreePath('/home/me/src/app/worktrees/k2')).toBe('/home/me/src/app/worktrees/k2');
    expect(foldWorktreePath('/srv/worktrees/a', isRepo)).toBe('/srv/worktrees/a');
  });
});

describe('pathKey and lastSegment', () => {
  it('prefixes the host, or keeps the plain path for no host', () => {
    expect(pathKey('laptop', '/home/me/app')).toBe('laptop:/home/me/app');
    expect(pathKey('', '/home/me/app')).toBe('/home/me/app');
  });
  it('takes the last path segment of either separator', () => {
    expect(lastSegment('example.com/acme/app')).toBe('app');
    expect(lastSegment('laptop:/home/me/app')).toBe('app');
    expect(lastSegment('C:\\Users\\me\\app')).toBe('app');
  });
});

describe('repoResolver', () => {
  let dir: string;
  let db: DB;
  let resolve: ReturnType<typeof repoResolver>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'history-resolve-'));
    db = openDatabase(join(dir, 'history.db'), { create: true });
    resolve = repoResolver(db);
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const map = (host: string, d: string, root: string, remote: string | null, at = 1) =>
    db.prepare('INSERT INTO repo_map(host, dir, root, remote, at) VALUES (?, ?, ?, ?, ?)').run(host, d, root, remote, at);
  const gitSession = (id: string, host: string, cwd: string) =>
    db.prepare("INSERT INTO sessions(id, project, host, cwd, git_branch, cwd_git, source) VALUES (?, 'p', ?, ?, 'main', 1, 'claude')")
      .run(id, host, cwd);

  it('step 1: the session git remote seen at its cwd (cwd_git = 1) wins over everything', () => {
    map('laptop', '/w/a', '/w/a', 'https://h.example/o/other.git');
    expect(resolve({ host: 'laptop', cwd: '/w/a', gitRemote: 'git@h.example:Team/App.git', cwdGit: true }))
      .toEqual({ key: 'h.example/team/app', name: 'app', root: '/w/a' });
  });

  it('a session remote not seen at its cwd (cwd_git = 0) yields to the map row for the cwd or its nearest parent', () => {
    map('laptop', '/w/b', '/w/b', 'https://h.example/o/b.git');
    map('laptop', '/w/c', '/w/c', null);
    const fromA = { host: 'laptop', gitRemote: 'https://h.example/o/a.git', cwdGit: false };
    expect(resolve({ ...fromA, cwd: '/w/b' })).toEqual({ key: 'h.example/o/b', name: 'b', root: '/w/b' });
    expect(resolve({ ...fromA, cwd: '/w/b/src/deep' })).toEqual({ key: 'h.example/o/b', name: 'b', root: '/w/b' });
    // a map row with no usable remote ends at a path key: key and root from the same row
    expect(resolve({ ...fromA, cwd: '/w/c/x' })).toEqual({ key: 'laptop:/w/c', name: 'c', root: '/w/c' });
    // with no map row, the session's remote is still used
    expect(resolve({ ...fromA, cwd: '/w/d' })).toEqual({ key: 'h.example/o/a', name: 'a', root: '/w/d' });
    // another host's map row never applies
    expect(resolve({ ...fromA, host: 'desktop', cwd: '/w/b' })).toEqual({ key: 'h.example/o/a', name: 'a', root: '/w/b' });
  });

  it('a session remote seen elsewhere (cwd_git = 0) yields to the remote another session saw at exactly its cwd', () => {
    const atCwd = (id: string, host: string, cwd: string, remote: string) =>
      db.prepare(`INSERT INTO sessions(id, project, host, cwd, git_remote, cwd_git, source)
        VALUES (?, 'p', ?, ?, ?, 1, 'codex')`).run(id, host, cwd, remote);
    const fromA = { host: 'laptop', cwd: '/w/d', gitRemote: 'https://h.example/o/a.git', cwdGit: false };
    // no implicit row: the session's own remote
    expect(resolve(fromA)).toEqual({ key: 'h.example/o/a', name: 'a', root: '/w/d' });
    // another host's session at the same path does not count
    atCwd('desk', 'desktop', '/w/d', 'https://h.example/o/desk.git');
    expect(resolve(fromA)).toEqual({ key: 'h.example/o/a', name: 'a', root: '/w/d' });
    // nor does one below the cwd
    atCwd('below', 'laptop', '/w/d/sub', 'https://h.example/o/sub.git');
    expect(resolve(fromA)).toEqual({ key: 'h.example/o/a', name: 'a', root: '/w/d' });
    // a same-host session that saw git at exactly the cwd: its remote wins
    atCwd('here', 'laptop', '/w/d', 'https://h.example/o/d.git');
    expect(resolve(fromA)).toEqual({ key: 'h.example/o/d', name: 'd', root: '/w/d' });
    expect(resolve({ ...fromA, cwd: '/w/d/' })).toEqual({ key: 'h.example/o/d', name: 'd', root: '/w/d' });
    // the session's own remote seen at its cwd still comes first
    expect(resolve({ ...fromA, cwdGit: true })).toEqual({ key: 'h.example/o/a', name: 'a', root: '/w/d' });
    // and a map row for the cwd still outranks the implicit row
    map('laptop', '/w/d', '/w/d', 'https://h.example/o/mapped.git');
    expect(resolve(fromA)).toEqual({ key: 'h.example/o/mapped', name: 'mapped', root: '/w/d' });
  });

  it('step 2: the map row for the cwd, or its longest ancestor, path-segment aware', () => {
    map('laptop', '/home/me/src/worktree-x', '/home/me/src/app', null);
    map('laptop', '/w/b', '/w/b-root', 'https://h.example/o/b.git');
    map('laptop', '/w/b/inner', '/w/inner-root', null);
    expect(resolve({ host: 'laptop', cwd: '/home/me/src/worktree-x/src', gitRemote: null }))
      .toEqual({ key: 'laptop:/home/me/src/app', name: 'app', root: '/home/me/src/app' });
    expect(resolve({ host: 'laptop', cwd: '/w/b/sub/dir', gitRemote: null }))
      .toEqual({ key: 'h.example/o/b', name: 'b', root: '/w/b-root' });
    expect(resolve({ host: 'laptop', cwd: '/w/b/inner/x', gitRemote: null })?.root).toBe('/w/inner-root');
    expect(resolve({ host: 'laptop', cwd: '/w/bc', gitRemote: null })).toEqual({ key: 'laptop:/w/bc', name: 'bc', root: '/w/bc' });
  });

  it('step 3: pattern folding when no map row matches', () => {
    expect(resolve({ host: 'laptop', cwd: '/w/app/.claude/worktrees/t1/src', gitRemote: null }))
      .toEqual({ key: 'laptop:/w/app', name: 'app', root: '/w/app' });
  });

  it('step 4: the cwd itself', () => {
    expect(resolve({ host: 'laptop', cwd: '/w/plain/', gitRemote: null }))
      .toEqual({ key: 'laptop:/w/plain', name: 'plain', root: '/w/plain' });
  });

  it('knows the repo from a remote alone, and returns null with nothing usable', () => {
    expect(resolve({ host: 'laptop', cwd: null, gitRemote: 'https://h.example/o/r.git', cwdGit: false }))
      .toEqual({ key: 'h.example/o/r', name: 'r', root: null });
    expect(resolve({ host: 'laptop', cwd: null, gitRemote: null })).toBeNull();
    expect(resolve({ host: 'laptop', cwd: null, gitRemote: 'nonsense', cwdGit: false })).toBeNull();
  });

  it('folds worktrees when a session with a git branch or remote, or a map entry, shows the parent is a repository', () => {
    const cwd = '/home/me/src/app/worktrees/k2';
    const input = { host: 'laptop', cwd, gitRemote: null };
    expect(resolve(input)?.root).toBe(cwd);
    // A bare session in the parent is weak evidence: a folder of repositories is a working directory too.
    db.prepare("INSERT INTO sessions(id, project, host, cwd, source) VALUES ('bare', 'p', 'laptop', '/home/me/src/app', 'claude')").run();
    expect(resolve(input)?.root).toBe(cwd);
    // A branch or remote recorded somewhere in the session is not enough: it may come from a later directory.
    db.prepare(`INSERT INTO sessions(id, project, host, cwd, git_branch, git_remote, source)
      VALUES ('moved', 'p', 'laptop', '/home/me/src/app', 'main', 'https://h.example/o/x.git', 'claude')`).run();
    expect(resolve(input)?.root).toBe(cwd);
    // Git evidence seen at that very directory (cwd_git) is.
    gitSession('p', 'laptop', '/home/me/src/app');
    expect(resolve(input)).toEqual({ key: 'laptop:/home/me/src/app', name: 'app', root: '/home/me/src/app' });
    db.prepare('DELETE FROM sessions').run();
    expect(resolve(input)?.root).toBe(cwd);
    map('laptop', '/elsewhere', '/home/me/src/app', null);
    expect(resolve(input)?.root).toBe('/home/me/src/app');
  });

  it('resolves the filesystem root to itself', () => {
    expect(resolve({ host: 'laptop', cwd: '/', gitRemote: null })).toEqual({ key: 'laptop:/', name: '/', root: '/' });
  });

  it('gives two cwds on different paths one key through a shared remote', () => {
    const a = resolve({ host: 'laptop', cwd: '/x/one', gitRemote: 'https://h.example/o/r.git', cwdGit: true });
    const b = resolve({ host: 'laptop', cwd: '/y/two', gitRemote: 'ssh://git@h.example:22/O/R', cwdGit: true });
    expect(a?.key).toBe('h.example/o/r');
    expect(b?.key).toBe(a?.key);
  });

  it('treats the same path on two hosts as two repositories', () => {
    expect(resolve({ host: 'laptop', cwd: '/home/me/app', gitRemote: null })!.key).toBe('laptop:/home/me/app');
    expect(resolve({ host: 'desktop', cwd: '/home/me/app', gitRemote: null })!.key).toBe('desktop:/home/me/app');
  });

  it("does not apply one host's map row or git evidence to another host", () => {
    map('laptop', '/home/me/app', '/home/me/app', 'https://example.com/acme/app.git');
    gitSession('tools', 'laptop', '/home/me/tools');
    // the same facts do apply on their own host
    expect(resolve({ host: 'laptop', cwd: '/home/me/app', gitRemote: null })!.key).toBe('example.com/acme/app');
    expect(resolve({ host: 'laptop', cwd: '/home/me/tools/worktrees/x', gitRemote: null })!.root).toBe('/home/me/tools');
    expect(resolve({ host: 'desktop', cwd: '/home/me/app', gitRemote: null })!.key).toBe('desktop:/home/me/app');
    expect(resolve({ host: 'desktop', cwd: '/home/me/tools/worktrees/x', gitRemote: null })!.root).toBe('/home/me/tools/worktrees/x');
  });

  it("does not take another host's implicit map row", () => {
    db.prepare(`INSERT INTO sessions(id, project, host, cwd, git_remote, cwd_git, source)
      VALUES ('codex', 'p', 'laptop', '/home/me/app', 'https://example.com/acme/app.git', 1, 'codex')`).run();
    expect(resolve({ host: 'laptop', cwd: '/home/me/app', gitRemote: null })!.key).toBe('example.com/acme/app');
    expect(resolve({ host: 'desktop', cwd: '/home/me/app', gitRemote: null })!.key).toBe('desktop:/home/me/app');
  });

  it('gives one key to a repository with a remote on every host', () => {
    map('laptop', '/home/me/app', '/home/me/app', 'https://example.com/acme/app.git');
    const laptop = resolve({ host: 'laptop', cwd: '/home/me/app/src', gitRemote: null });
    const desktop = resolve({ host: 'desktop', cwd: '/srv/code/app', gitRemote: 'git@example.com:acme/app.git', cwdGit: true });
    expect(laptop).toEqual({ key: 'example.com/acme/app', name: 'app', root: '/home/me/app' });
    expect(desktop).toEqual({ key: 'example.com/acme/app', name: 'app', root: '/srv/code/app' });
  });

  it('does not fold a worktrees folder that sits in a folder of unrelated repositories', () => {
    gitSession('alpha', 'laptop', '/home/me/src/alpha');
    gitSession('beta', 'laptop', '/home/me/src/beta');
    expect(resolve({ host: 'laptop', cwd: '/home/me/src/worktrees/alpha-fix', gitRemote: null })!.root)
      .toBe('/home/me/src/worktrees/alpha-fix');
  });

  it('keys a Windows working directory by its own path', () => {
    expect(resolve({ host: 'pc', cwd: 'C:\\Users\\me\\app', gitRemote: null }))
      .toEqual({ key: 'pc:C:\\Users\\me\\app', name: 'app', root: 'C:\\Users\\me\\app' });
    expect(resolve({ host: 'pc', cwd: 'C:\\', gitRemote: null })!.key).toBe('pc:C:\\');
  });

  it('keeps a plain path key for a session with no host', () => {
    expect(resolve({ host: '', cwd: '/home/me/app', gitRemote: null }))
      .toEqual({ key: '/home/me/app', name: 'app', root: '/home/me/app' });
    map('', '/home/me/lib', '/home/me/lib-root', null);
    expect(resolve({ host: '', cwd: '/home/me/lib', gitRemote: null })!.key).toBe('/home/me/lib-root');
  });
});

describe('resolveAllSessions', () => {
  let dir: string;
  let db: DB;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'history-resolve-all-'));
    db = openDatabase(join(dir, 'history.db'), { create: true });
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const session = (id: string, cwd: string | null, remote: string | null, cwdGit = 0, host = 'laptop') =>
    db.prepare("INSERT INTO sessions(id, project, host, cwd, git_remote, cwd_git, source) VALUES (?, 'p', ?, ?, ?, ?, 'claude')")
      .run(id, host, cwd, remote, cwdGit);
  const repo = (id: string) => db.prepare('SELECT repo, repo_root FROM sessions WHERE id = ?').get(id);

  it('resolves every session once, writes only changes, and leaves unknowns null', () => {
    session('a', '/w/app/.claude/worktrees/t', null);
    session('b', null, 'https://h.example/o/r.git');
    session('c', null, null);
    session('d', '/w/x', null);
    db.prepare("INSERT INTO repo_map(host, dir, root, remote, at) VALUES ('laptop', '/w/x', '/w/xroot', NULL, 1)").run();

    expect(resolveAllSessions(db)).toEqual({ changed: 3 });
    expect(repo('a')).toEqual({ repo: 'laptop:/w/app', repo_root: '/w/app' });
    expect(repo('b')).toEqual({ repo: 'h.example/o/r', repo_root: null });
    expect(repo('c')).toEqual({ repo: null, repo_root: null });
    expect(repo('d')).toEqual({ repo: 'laptop:/w/xroot', repo_root: '/w/xroot' });

    expect(resolveAllSessions(db)).toEqual({ changed: 0 });
    session('e', '/w/hf/worktrees/k', null);
    session('f', '/w/hf', null, 1);
    expect(resolveAllSessions(db)).toEqual({ changed: 2 });
    expect(repo('e')).toEqual({ repo: 'laptop:/w/hf', repo_root: '/w/hf' });
    db.prepare("UPDATE repo_map SET root = '/w/moved', at = 2 WHERE dir = '/w/x'").run();
    expect(resolveAllSessions(db)).toEqual({ changed: 1 });
    expect(repo('d')).toEqual({ repo: 'laptop:/w/moved', repo_root: '/w/moved' });
  });

  it('folds by evidence of the same host only', () => {
    session('lap-main', '/w/p1', null, 1, 'laptop');
    session('lap-wt', '/w/p1/worktrees/n', null, 0, 'laptop');
    session('desk-wt', '/w/p1/worktrees/n', null, 0, 'desktop');
    session('desk-plain', '/w/p2', null, 0, 'desktop');
    session('lap-codex', '/w/p2', 'https://h.example/o/p2.git', 1, 'laptop');
    db.prepare("INSERT INTO repo_map(host, dir, root, remote, at) VALUES ('laptop', '/w/p3', '/w/p3', 'https://h.example/o/p3.git', 1)").run();
    session('desk-p3', '/w/p3', null, 0, 'desktop');
    resolveAllSessions(db);
    expect(repo('lap-wt')).toEqual({ repo: 'laptop:/w/p1', repo_root: '/w/p1' });
    expect(repo('desk-wt')).toEqual({ repo: 'desktop:/w/p1/worktrees/n', repo_root: '/w/p1/worktrees/n' });
    expect(repo('desk-plain')).toEqual({ repo: 'desktop:/w/p2', repo_root: '/w/p2' });
    expect(repo('desk-p3')).toEqual({ repo: 'desktop:/w/p3', repo_root: '/w/p3' });
  });

  it('agrees with the per-session resolver', () => {
    for (let i = 0; i < 20; i++) session(`plain-${i}`, `/w/p${i}`, null, i % 2, i % 3 ? 'laptop' : 'desktop');
    session('claude-wt', '/w/p1/.claude/worktrees/t', null);
    session('wt', '/w/p1/worktrees/n', null);
    session('wt2', '/w/p0/worktrees/n', null);
    session('remote-only', null, 'https://h.example/o/r.git');
    session('implicit', '/w/p5', 'https://h.example/o/p5.git', 1);
    // a remote seen elsewhere (cwd_git = 0): the map row wins where there is one, on its host only
    session('elsewhere-mapped', '/w/p3/src', 'https://h.example/o/a.git', 0);
    session('elsewhere-mapped-desk', '/w/p3/src', 'https://h.example/o/a.git', 0, 'desktop');
    session('elsewhere-mapped-null', '/w/p2', 'https://h.example/o/a.git', 0);
    session('elsewhere-unmapped', '/w/p6', 'https://h.example/o/a.git', 0);
    session('here-mapped', '/w/p3', 'https://h.example/o/own.git', 1);
    // a remote seen elsewhere, at a cwd with an implicit row (implicit, at /w/p5): the implicit row wins
    session('elsewhere-implicit', '/w/p5', 'https://h.example/o/a.git', 0);
    session('elsewhere-implicit-desk', '/w/p5', 'https://h.example/o/a.git', 0, 'desktop');
    db.prepare("INSERT INTO repo_map(host, dir, root, remote, at) VALUES ('laptop', '/w/p2', '/w/main', NULL, 1)").run();
    db.prepare("INSERT INTO repo_map(host, dir, root, remote, at) VALUES ('laptop', '/w/p3', '/w/p3', 'https://h.example/o/p3.git', 1)").run();
    resolveAllSessions(db);
    expect(repo('elsewhere-mapped')).toEqual({ repo: 'h.example/o/p3', repo_root: '/w/p3' });
    expect(repo('elsewhere-mapped-desk')).toEqual({ repo: 'h.example/o/a', repo_root: '/w/p3/src' });
    expect(repo('elsewhere-mapped-null')).toEqual({ repo: 'laptop:/w/main', repo_root: '/w/main' });
    expect(repo('elsewhere-unmapped')).toEqual({ repo: 'h.example/o/a', repo_root: '/w/p6' });
    expect(repo('here-mapped')).toEqual({ repo: 'h.example/o/own', repo_root: '/w/p3' });
    expect(repo('elsewhere-implicit')).toEqual({ repo: 'h.example/o/p5', repo_root: '/w/p5' });
    expect(repo('elsewhere-implicit-desk')).toEqual({ repo: 'h.example/o/a', repo_root: '/w/p5' });
    const resolve = repoResolver(db);
    const rows = db.prepare('SELECT host, cwd, git_remote, cwd_git, repo, repo_root FROM sessions').all() as Array<{
      host: string; cwd: string | null; git_remote: string | null; cwd_git: number; repo: string | null; repo_root: string | null;
    }>;
    for (const r of rows) {
      const want = resolve({ host: r.host, cwd: r.cwd, gitRemote: r.git_remote, cwdGit: r.cwd_git === 1 });
      expect({ repo: r.repo, repo_root: r.repo_root }).toEqual({ repo: want?.key ?? null, repo_root: want?.root ?? null });
    }
  });
});

describe('repoResolvedStamp', () => {
  const saved = { dirs: process.env.CLAUDE_HISTORY_WORKTREE_DIRS, aliases: process.env.CLAUDE_HISTORY_REPO_HOST_ALIASES };
  afterEach(() => {
    for (const [k, v] of [['CLAUDE_HISTORY_WORKTREE_DIRS', saved.dirs], ['CLAUDE_HISTORY_REPO_HOST_ALIASES', saved.aliases]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('changes with the aliases and the container names, but not their order', () => {
    delete process.env.CLAUDE_HISTORY_WORKTREE_DIRS;
    delete process.env.CLAUDE_HISTORY_REPO_HOST_ALIASES;
    const base = repoResolvedStamp();
    expect(base).toMatch(/^4:[0-9a-f]{8}$/);
    process.env.CLAUDE_HISTORY_WORKTREE_DIRS = 'worktrees,.worktrees';
    expect(repoResolvedStamp()).toBe(base);
    process.env.CLAUDE_HISTORY_WORKTREE_DIRS = 'wt';
    const wt = repoResolvedStamp();
    expect(wt).not.toBe(base);
    process.env.CLAUDE_HISTORY_WORKTREE_DIRS = '';
    expect(repoResolvedStamp()).not.toBe(base);
    expect(repoResolvedStamp()).not.toBe(wt);
    delete process.env.CLAUDE_HISTORY_WORKTREE_DIRS;
    process.env.CLAUDE_HISTORY_REPO_HOST_ALIASES = 'git.internal=example.com';
    expect(repoResolvedStamp()).not.toBe(base);
  });
});

describe('distinctNames', () => {
  it('names repositories by their last segment, and tells shared names apart', () => {
    const names = distinctNames([
      { key: 'example.com/acme/app', root: '/home/me/app' },
      { key: 'laptop:/home/me/other/app', root: '/home/me/other/app' },
      { key: 'example.com/acme/tools', root: null },
    ], (root) => root);
    expect(names.get('example.com/acme/tools')).toBe('tools');
    expect(names.get('example.com/acme/app')).toBe('/home/me/app');
    expect(names.get('laptop:/home/me/other/app')).toBe('/home/me/other/app');
  });

  it('never puts a host prefix in a name, and agrees with Repo.name', () => {
    const names = distinctNames([
      { key: 'laptop:/', root: '/' },
      { key: 'desktop:/home/me/app', root: null },
      { key: 'example.com:8080/acme/tools', root: null },
    ], (root) => root);
    expect(names.get('laptop:/')).toBe('/');
    expect(names.get('desktop:/home/me/app')).toBe('app');
    expect(names.get('example.com:8080/acme/tools')).toBe('tools');
    expect(repoName('laptop:/home/me/app')).toBe('app');
    expect(repoName('/home/me/app')).toBe('app');
    expect(repoName('example.com/acme/app')).toBe('app');
  });

  it('treats a Windows path as a path key, with or without a host', () => {
    const labels = (keys: string[]) =>
      Object.fromEntries(distinctNames(keys.map((key) => ({ key, root: null })), () => null));
    expect(labels(['hostA:C:\\w\\app', 'hostB:C:\\w\\app'])).toEqual({
      'hostA:C:\\w\\app': 'app @hostA',
      'hostB:C:\\w\\app': 'app @hostB',
    });
    expect(repoName('hostA:C:\\w\\app')).toBe('app');
    expect(repoName('C:\\w\\app')).toBe('app');
    // bare drive path (host unknown) beside a path key with a host: the bare one has no host label
    expect(labels(['C:\\w\\app', 'hostA:C:\\w\\app'])['hostA:C:\\w\\app']).toBe('app @hostA');
    expect(pathKeyHost('hostA:C:\\w\\app')).toBe('hostA');
    expect(pathKeyHost('C:\\w\\app')).toBeNull();
    expect(pathKeyHost('hostA:\\\\srv\\share\\app')).toBe('hostA');
    // a remote with a port is still a remote
    expect(pathKeyHost('example.com:8080/acme/tools')).toBeNull();
    expect(labels(['example.com:8080/acme/tools', 'other.example.com/acme/tools'])).toEqual({
      'example.com:8080/acme/tools': 'example.com:8080/acme/tools',
      'other.example.com/acme/tools': 'other.example.com/acme/tools',
    });
  });

  describe('repositories sharing a name', () => {
    const none = () => null;
    const labels = (keys: string[], reserved: string[] = []) =>
      Object.fromEntries(distinctNames(keys.map((key) => ({ key, root: '/w/app' })), none, new Set(reserved)));

    it('tells one repository under two owners apart by owner/name', () => {
      expect(labels(['git.example.com/alice/app', 'git.example.com/team/app'])).toEqual({
        'git.example.com/alice/app': 'alice/app',
        'git.example.com/team/app': 'team/app',
      });
    });

    it('tells one owner and name on two remote hosts apart by the full key', () => {
      expect(labels(['git.example.com/alice/app', 'git.internal.example.com/alice/app'])).toEqual({
        'git.example.com/alice/app': 'git.example.com/alice/app',
        'git.internal.example.com/alice/app': 'git.internal.example.com/alice/app',
      });
    });

    it('gives a lone owner owner/name and the colliding pair their full keys', () => {
      expect(labels(['git.example.com/alice/app', 'git.internal.example.com/alice/app', 'git.example.com/team/app'])).toEqual({
        'git.example.com/team/app': 'team/app',
        'git.example.com/alice/app': 'git.example.com/alice/app',
        'git.internal.example.com/alice/app': 'git.internal.example.com/alice/app',
      });
    });

    it('tells one path on two hosts apart by host', () => {
      expect(labels(['hostA:/w/app', 'hostB:/w/app'])).toEqual({ 'hostA:/w/app': 'app @hostA', 'hostB:/w/app': 'app @hostB' });
    });

    it('numbers path keys with no host that cannot be told apart', () => {
      expect(labels(['/w/a/app', '/w/b/app'])).toEqual({ '/w/a/app': 'app (1)', '/w/b/app': 'app (2)' });
    });

    it('still prefers a unique path label', () => {
      const names = distinctNames(
        [{ key: 'git.example.com/alice/app', root: '/w/a' }, { key: 'git.example.com/team/app', root: '/w/b' }],
        (root) => root,
      );
      expect([...names.values()].sort()).toEqual(['/w/a', '/w/b']);
    });

    it('skips a new label another row already has', () => {
      expect(labels(['git.example.com/alice/app', 'git.example.com/team/app'], ['alice/app'])).toEqual({
        'git.example.com/alice/app': 'git.example.com/alice/app',
        'git.example.com/team/app': 'team/app',
      });
      expect(labels(['hostA:/w/app', 'hostB:/w/app'], ['app @hostA'])).toEqual({ 'hostA:/w/app': 'app (1)', 'hostB:/w/app': 'app @hostB' });
    });
  });
});

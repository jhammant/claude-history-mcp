import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sweep } from '../../src/indexing/sweep.js';
import { createCorpus, rolloutCall, rolloutMessage, rolloutMeta, rolloutTurn, userLine, type Corpus } from '../helpers/corpus.js';

const U1 = '0199dddd-0000-7000-8000-000000000001';
const U2 = '0199dddd-0000-7000-8000-000000000002';
const U3 = '0199dddd-0000-7000-8000-000000000003';

/** sessions.cwd_git: git evidence seen on a line at the session's own cwd, and only that. */
describe('git evidence at the session cwd', () => {
  let corpus: Corpus;
  beforeEach(() => { corpus = createCorpus(); });
  afterEach(() => corpus.cleanup());

  const row = (id: string) =>
    corpus.open().prepare('SELECT cwd, git_branch, cwd_git FROM sessions WHERE id = ?').get(id) as
      { cwd: string; git_branch: string | null; cwd_git: number };

  it('does not count a branch read after the session moved out of its cwd', () => {
    corpus.write(corpus.sessionPath('-work-folder', 'moved'), [
      userLine('start in the folder', { cwd: '/work/folder', sessionId: 'moved', gitBranch: '' }),
      userLine('now in a repository', { cwd: '/work/folder/repoA', sessionId: 'moved', gitBranch: 'main' }),
    ]);
    sweep(corpus.open());
    expect(row('moved')).toMatchObject({ cwd: '/work/folder', git_branch: 'main', cwd_git: 0 });
  });

  it('counts a branch on a line at the session cwd', () => {
    corpus.write(corpus.sessionPath('-work-repo', 'main'), [userLine('hi', { cwd: '/work/repo', sessionId: 'main', gitBranch: 'main' })]);
    sweep(corpus.open());
    expect(row('main')).toMatchObject({ cwd: '/work/repo', cwd_git: 1 });
  });

  it('sets the flag on a resumed read when a later line at the stored cwd carries a branch', () => {
    const path = corpus.write(corpus.sessionPath('-work-repo', 'main'), [
      userLine('hi', { cwd: '/work/repo', sessionId: 'main', gitBranch: '' }),
    ]);
    const db = corpus.open();
    sweep(db);
    expect(row('main').cwd_git).toBe(0);

    corpus.append(path, [userLine('git init done', { cwd: '/work/repo', sessionId: 'main', gitBranch: 'main' })]);
    sweep(db);
    expect(row('main').cwd_git).toBe(1);
    corpus.append(path, [userLine('later', { cwd: '/work/repo', sessionId: 'main', gitBranch: '' })]);
    sweep(db);
    expect(row('main').cwd_git).toBe(1); // only ever raised
  });

  it('gives a Codex session with header cwd and git cwd_git = 1', () => {
    corpus.write(corpus.rolloutPath('2026-10-01', U1), [
      rolloutMeta(U1, { cwd: '/work/app', repositoryUrl: 'https://git.example.org/team/app.git' }),
      rolloutMessage('user', 'hello there'),
    ]);
    sweep(corpus.open());
    expect(row(`codex-${U1}`)).toMatchObject({ cwd: '/work/app', cwd_git: 1 });
  });

  const codexRow = (u: string) =>
    corpus.open().prepare('SELECT cwd, git_remote, cwd_git FROM sessions WHERE id = ?').get(`codex-${u}`);

  it('gives the Codex header git no evidence for a turn_context cwd that differs, and keeps the remote', () => {
    corpus.write(corpus.rolloutPath('2026-10-01', U2), [
      rolloutMeta(U2, { cwd: '/w/repoA', repositoryUrl: 'https://git.example.org/team/repoA.git' }),
      rolloutTurn('/w/folder'),
      rolloutMessage('user', 'hello from the folder'),
    ]);
    sweep(corpus.open());
    expect(codexRow(U2)).toMatchObject({ cwd: '/w/folder', git_remote: 'https://git.example.org/team/repoA.git', cwd_git: 0 });
  });

  it('gives no evidence to an exec_command workdir on the first emitted line', () => {
    corpus.write(corpus.rolloutPath('2026-10-01', U3), [
      rolloutMeta(U3, { cwd: '/w/repoA', repositoryUrl: 'https://git.example.org/team/repoA.git' }),
      rolloutCall('exec_command', { cmd: 'ls', workdir: '/w/folder' }, 'call-1'),
      rolloutMessage('user', 'and then'),
    ]);
    sweep(corpus.open());
    expect(codexRow(U3)).toMatchObject({ cwd: '/w/folder', git_remote: 'https://git.example.org/team/repoA.git', cwd_git: 0 });
  });

  it("stores a Codex session's remote without credentials", () => {
    const U4 = '0199dddd-0000-7000-8000-000000000004';
    corpus.write(corpus.rolloutPath('2026-10-01', U4), [
      rolloutMeta(U4, { cwd: '/work/app', repositoryUrl: 'https://user:tok@example.com/acme/app.git' }),
      rolloutMessage('user', 'hello there'),
    ]);
    sweep(corpus.open());
    expect(codexRow(U4)).toMatchObject({ git_remote: 'https://example.com/acme/app.git' });
  });
});

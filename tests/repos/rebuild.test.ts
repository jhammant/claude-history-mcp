import { rmSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { rebuild } from '../../src/indexing/rebuild.js';
import { sweep } from '../../src/indexing/sweep.js';
import { useHost } from '../helpers/host.js';
import { createCorpus, rolloutMessage, rolloutMeta, userLine, type Corpus } from '../helpers/corpus.js';

const U1 = '0199ffff-0000-7000-8000-000000000001';

/** A rebuild keeps the repository evidence of archived sessions and re-derives the rest. */
describe('rebuild and repository identity', () => {
  useHost();
  let corpus: Corpus;
  beforeEach(() => { corpus = createCorpus(); });
  afterEach(() => corpus.cleanup());

  it('carries git_remote, cwd_git, repo and repo_root over for an archived session, and re-derives a re-read one', async () => {
    const gone = corpus.write(corpus.rolloutPath('2026-10-01', U1), [
      rolloutMeta(U1, { cwd: '/w/app', repositoryUrl: 'https://git.example.org/team/app.git' }),
      rolloutMessage('user', 'hello there'),
    ]);
    corpus.write(corpus.sessionPath('-w-app-sub', 'kept'), [userLine('hi', { cwd: '/w/app/sub', sessionId: 'kept' })]);
    corpus.write(corpus.sessionPath('-w-app', 'same'), [userLine('hi', { cwd: '/w/app', sessionId: 'same' })]);
    sweep(corpus.open(), { probeRepos: false });
    const cols = 'id, git_remote, cwd_git, repo, repo_root';
    const before = corpus.open().prepare(`SELECT ${cols} FROM sessions ORDER BY id`).all();
    expect(before).toContainEqual({
      id: `codex-${U1}`, git_remote: 'https://git.example.org/team/app.git', cwd_git: 1,
      repo: 'git.example.org/team/app', repo_root: '/w/app',
    });
    rmSync(gone);
    corpus.open().close();

    const stats = await rebuild(join(corpus.dataDir, 'history.db'));

    expect(stats.carriedSessions).toBe(1);
    const db = openDatabase(join(corpus.dataDir, 'history.db'));
    try {
      expect(db.prepare(`SELECT ${cols} FROM sessions ORDER BY id`).all()).toEqual(before);
      // The re-read session at the archived session's cwd takes its remote through the implicit map row.
      expect(db.prepare("SELECT repo FROM sessions WHERE id = 'same'").pluck().get()).toBe('git.example.org/team/app');
      expect(db.prepare("SELECT repo FROM sessions WHERE id = 'kept'").pluck().get()).toBe('laptop:/w/app/sub');
    } finally {
      db.close();
    }
  });
});

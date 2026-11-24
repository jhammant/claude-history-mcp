import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sweep } from '../../src/indexing/sweep.js';
import { handleListProjects } from '../../src/tools/list-projects.js';
import { SearchEngine } from '../../src/search/search-engine.js';
import { matchProjects, matchRepos } from '../../src/tools/project-match.js';
import { assistantText, createCorpus, rolloutMessage, rolloutMeta, userLine, type Corpus } from '../helpers/corpus.js';

describe('list_projects', () => {
  let corpus: Corpus;

  beforeEach(() => {
    corpus = createCorpus();
    for (let i = 0; i < 35; i++) {
      const name = i === 7 ? 'billing' : `app${i}`;
      corpus.write(corpus.sessionPath(`-work-${name}`, `5e55-${i}`), [
        userLine(`question ${i}`, { cwd: `/work/${name}` }),
        assistantText(`answer ${i}`, { cwd: `/work/${name}` }),
      ]);
    }
    sweep(corpus.open());
  });
  afterEach(() => corpus.cleanup());

  it('caps the list by default and says how many are hidden', () => {
    // Act
    const text = handleListProjects(corpus.open(), {});

    // Assert
    expect(text).toContain('35 projects with conversation history, showing 30:');
    expect(text.match(/^- /gm)).toHaveLength(30);
    expect(text).toContain('5 more not shown');
  });

  it('honours limit', () => {
    const text = handleListProjects(corpus.open(), { limit: 3 });

    expect(text.match(/^- /gm)).toHaveLength(3);
    expect(text).toContain('32 more not shown');
  });

  it('filters by a part of the path', () => {
    const text = handleListProjects(corpus.open(), { query: 'Billing' });

    expect(text).toContain('1 project with conversation history matching "Billing":');
    expect(text).toContain('- billing — 1 sessions, 2 messages');
    expect(text).not.toContain('more not shown');
  });

  it('says so when nothing matches the filter', () => {
    const text = handleListProjects(corpus.open(), { query: 'nope' });

    expect(text).toBe('No projects match "nope" (35 projects have history).');
  });

  it('leaves out Codex sessions with no messages (guardian-review threads): no unknown row, no count', () => {
    const u = '0199abcd-0000-7000-8000-000000000001';
    corpus.write(corpus.rolloutPath('2026-10-01', u), [
      rolloutMeta(u, { threadSource: 'guardian_review', parentThreadId: '0199abcd-0000-7000-8000-000000000000' }),
      rolloutMessage('user', 'review this action'),
    ]);
    corpus.write(corpus.sessionPath('-work-billing', 'empty-billing'), [userLine('', { cwd: '/work/billing', sessionId: 'empty-billing', isMeta: true })]);
    sweep(corpus.open());
    const db = corpus.open();
    expect(db.prepare("SELECT count(*) FROM sessions WHERE message_count = 0").pluck().get()).toBeGreaterThanOrEqual(1);

    const text = handleListProjects(db, { limit: 200 });
    expect(text).toContain('35 projects with conversation history:');
    expect(text).not.toMatch(/unknown/i);
    // A Claude session with no messages is counted, as it always was.
    expect(handleListProjects(db, { query: 'billing' })).toContain('- billing — 2 sessions, 2 messages');
  });

  it('still lists a project whose only Claude session has no messages', () => {
    corpus.write(corpus.sessionPath('-work-quiet', 'quiet-1'), [userLine('', { cwd: '/work/quiet', sessionId: 'quiet-1', isMeta: true })]);
    sweep(corpus.open());
    const db = corpus.open();
    expect(db.prepare("SELECT message_count FROM sessions WHERE id = 'quiet-1'").pluck().get()).toBe(0);

    const text = handleListProjects(db, { limit: 200 });

    expect(text).toContain('36 projects with conversation history:');
    expect(text).toMatch(/- \S*quiet — 1 sessions, 0 messages/);
  });
});

describe('list_projects across hosts', () => {
  let corpus: Corpus;
  let saved: string | undefined;
  beforeEach(() => { corpus = createCorpus(); saved = process.env.CLAUDE_HISTORY_HOST; });
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDE_HISTORY_HOST; else process.env.CLAUDE_HISTORY_HOST = saved;
    corpus.cleanup();
  });
  const onHost = (host: string, write: () => void) => {
    process.env.CLAUDE_HISTORY_HOST = host;
    write();
    sweep(corpus.open(), { probeRepos: false });
  };

  it('lists the same path on two hosts as two rows, told apart by host, when neither has a remote', () => {
    for (const host of ['laptop', 'desktop']) {
      onHost(host, () => corpus.write(corpus.sessionPath('-home-me-app', `s-${host}`), [
        userLine('hello', { cwd: '/home/me/app', sessionId: `s-${host}` }),
        assistantText('hi', { cwd: '/home/me/app', sessionId: `s-${host}` }),
      ]));
    }
    const db = corpus.open();
    expect(db.prepare('SELECT DISTINCT repo FROM sessions ORDER BY repo').pluck().all())
      .toEqual(['desktop:/home/me/app', 'laptop:/home/me/app']);

    const out = handleListProjects(db, {});

    expect(out.match(/^- /gm)).toHaveLength(2);
    expect(out).not.toContain('laptop:/');
    expect(out).not.toContain('desktop:/');
    expect(out).toMatch(/^- app @desktop — 1 sessions/m);
    expect(out).toMatch(/^- app @laptop — 1 sessions/m);
    expect(out).toContain('  Hosts: laptop');
    expect(out).toContain('  Hosts: desktop');
  });

  it('lists one row with both hosts for a repository with a remote', () => {
    for (const [host, n] of [['laptop', 1], ['desktop', 2]] as const) {
      const u = `0199abcd-0000-7000-8000-00000000000${n}`;
      onHost(host, () => corpus.write(corpus.rolloutPath('2026-10-01', u), [
        rolloutMeta(u, { cwd: `/home/${host}/app`, repositoryUrl: 'https://example.com/acme/app.git' }),
        rolloutMessage('user', 'hello there'),
      ]));
    }

    const out = handleListProjects(corpus.open(), {});

    expect(out.match(/^- /gm)).toHaveLength(1);
    expect(out).toMatch(/^- app — 2 sessions/m);
    expect(out).toContain('Hosts: desktop, laptop');
    expect(out).not.toContain('example.com');
  });

  it('prints an empty host as unknown, and no Hosts line while there is only one host', () => {
    onHost('laptop', () => corpus.write(corpus.sessionPath('-home-me-app', 'a'), [userLine('hi', { cwd: '/home/me/app', sessionId: 'a' })]));
    expect(handleListProjects(corpus.open(), {})).not.toContain('Hosts:');
    onHost('desktop', () => corpus.write(corpus.sessionPath('-home-me-b', 'b'), [userLine('hi', { cwd: '/home/me/b', sessionId: 'b' })]));
    onHost('desktop', () => corpus.write(corpus.sessionPath('-home-me-c', 'c'), [userLine('hi', { cwd: '/home/me/c', sessionId: 'c' })]));
    corpus.open().prepare("UPDATE sessions SET host = '' WHERE id = 'b'").run();
    const out = handleListProjects(corpus.open(), {});
    expect(out).toContain('Hosts: unknown');
    expect(out).toContain('Hosts: laptop');
  });

  it('folds a repository-less session into the repository of its project dir on the same host', () => {
    for (const id of ['r1', 'r2']) {
      onHost('laptop', () => corpus.write(corpus.sessionPath('-home-me-app', id), [
        userLine('hello', { cwd: '/home/me/app', sessionId: id }),
        assistantText('hi', { cwd: '/home/me/app', sessionId: id }),
      ]));
    }
    corpus.open().prepare("UPDATE sessions SET repo = NULL, repo_root = NULL WHERE id = 'r2'").run();

    const out = handleListProjects(corpus.open(), {});

    expect(out.match(/^- /gm)).toHaveLength(1);
    expect(out).toMatch(/^- app — 2 sessions, 4 messages/m);
  });

  it('does not fold a repository-less session of another host into the repository', () => {
    onHost('laptop', () => corpus.write(corpus.sessionPath('-home-me-app', 'l1'), [
      userLine('hello', { cwd: '/home/me/app', sessionId: 'l1' }),
      assistantText('hi', { cwd: '/home/me/app', sessionId: 'l1' }),
    ]));
    onHost('desktop', () => corpus.write(corpus.sessionPath('-home-me-app', 'd1'), [
      userLine('hello', { cwd: '/home/me/app', sessionId: 'd1' }),
      assistantText('hi', { cwd: '/home/me/app', sessionId: 'd1' }),
    ]));
    corpus.open().prepare("UPDATE sessions SET repo = NULL, repo_root = NULL WHERE id = 'd1'").run();

    const out = handleListProjects(corpus.open(), {});

    expect(out.match(/^- /gm)).toHaveLength(2);
    expect(out).toMatch(/^- app — 1 sessions, 2 messages/m);
    expect(out).toContain('  Hosts: laptop');
    expect(out).toContain('  Hosts: desktop');
    expect(out).not.toContain('Hosts: desktop, laptop');
  });

  it('still counts a Claude session with no messages', () => {
    onHost('laptop', () => corpus.write(corpus.sessionPath('-home-me-quiet', 'q'), [
      userLine('', { cwd: '/home/me/quiet', sessionId: 'q', isMeta: true }),
    ]));
    expect(corpus.open().prepare("SELECT message_count FROM sessions WHERE id = 'q'").pluck().get()).toBe(0);

    expect(handleListProjects(corpus.open(), {})).toMatch(/^- quiet — 1 sessions, 0 messages/m);
  });
});

describe('a schema 3 database before any rebuild (repo NULL everywhere)', () => {
  let corpus: Corpus;
  beforeEach(() => {
    corpus = createCorpus();
    for (const [dir, id] of [['app', 'a1'], ['app', 'a2'], ['tools', 't1']]) {
      corpus.write(corpus.sessionPath(`-work-${dir}`, id), [
        userLine('gearbox question', { cwd: `/work/${dir}`, sessionId: id }),
        assistantText('answer', { cwd: `/work/${dir}`, sessionId: id }),
      ]);
    }
    sweep(corpus.open(), { probeRepos: false });
    corpus.open().prepare('UPDATE sessions SET repo = NULL, repo_root = NULL').run();
  });
  afterEach(() => corpus.cleanup());

  it('lists projects grouped by project dir, as parcel 1 did', () => {
    const out = handleListProjects(corpus.open(), {});

    expect(out).toContain('2 projects with conversation history:');
    expect(out).toMatch(/^- \/work\/app — 2 sessions, 4 messages$/m);
    expect(out).toMatch(/^- \/work\/tools — 1 sessions, 2 messages$/m);
  });

  it('matches projects and filters search by the project dir', () => {
    const db = corpus.open();

    expect(matchProjects(db, 'app')).toEqual(['-work-app']);
    expect(matchProjects(db, '/work/tools')).toEqual(['-work-tools']);
    expect(new SearchEngine(db).search('gearbox project:app').hits.map((h) => h.sessionId).sort()).toEqual(['a1', 'a2']);
    expect(new SearchEngine(db).search('gearbox', { project: 'tools' }).hits.map((h) => h.sessionId)).toEqual(['t1']);
  });
});

describe('a schema 3 database after its first sweep (hosts unknown, plain path keys)', () => {
  let corpus: Corpus;
  beforeEach(() => {
    corpus = createCorpus();
    for (const [dir, id] of [['app', 'a1'], ['app', 'a2'], ['tools', 't1']]) {
      corpus.write(corpus.sessionPath(`-work-${dir}`, id), [
        userLine('gearbox question', { cwd: `/work/${dir}`, sessionId: id }),
        assistantText('answer', { cwd: `/work/${dir}`, sessionId: id }),
      ]);
    }
    const db = corpus.open();
    sweep(db, { probeRepos: false });
    // As schema 3 sessions just migrated: no host, no repository, never resolved.
    db.prepare("UPDATE sessions SET host = '', repo = NULL, repo_root = NULL").run();
    db.prepare("DELETE FROM meta WHERE key = 'repo_resolved'").run();
    // The upgrade's first sweep: no transcript changed, so only the full pass runs.
    sweep(db, { probeRepos: false });
  });
  afterEach(() => corpus.cleanup());

  it('keys the old sessions by their plain path and keeps their host unknown', () => {
    expect(corpus.open().prepare('SELECT id, host, repo, repo_root FROM sessions ORDER BY id').all()).toEqual([
      { id: 'a1', host: '', repo: '/work/app', repo_root: '/work/app' },
      { id: 'a2', host: '', repo: '/work/app', repo_root: '/work/app' },
      { id: 't1', host: '', repo: '/work/tools', repo_root: '/work/tools' },
    ]);
  });

  it('lists one project per repository, with no host line', () => {
    const out = handleListProjects(corpus.open(), {});

    expect(out).toContain('2 projects with conversation history:');
    expect(out).toMatch(/^- app — 2 sessions, 4 messages\n {2}Directory: \/work\/app$/m);
    expect(out).toMatch(/^- tools — 1 sessions, 2 messages\n {2}Directory: \/work\/tools$/m);
    expect(out).not.toContain('Hosts:');
  });

  it('matches projects and filters search by the repository', () => {
    const db = corpus.open();

    expect(new SearchEngine(db).search('gearbox project:app').hits.map((h) => h.sessionId).sort()).toEqual(['a1', 'a2']);
    expect(new SearchEngine(db).search('gearbox', { project: '/work/tools' }).hits.map((h) => h.sessionId)).toEqual(['t1']);
  });
});

describe('repositories sharing a name', () => {
  let corpus: Corpus;
  beforeEach(() => {
    corpus = createCorpus();
    for (const [i, owner] of ['alice', 'team'].entries()) {
      const u = `0199dddd-0000-7000-8000-00000000000${i}`;
      corpus.write(corpus.rolloutPath('2026-10-01', u), [
        rolloutMeta(u, { cwd: '/work/app', repositoryUrl: `https://git.example.com/${owner}/app.git`, timestamp: `2026-10-0${i + 1}T09:00:00Z` }),
        rolloutMessage('user', 'hello', { timestamp: `2026-10-0${i + 1}T09:00:00Z` }),
      ]);
    }
    sweep(corpus.open());
  });
  afterEach(() => corpus.cleanup());

  it('labels them by owner, and the label works as a filter', () => {
    const text = handleListProjects(corpus.open(), {});
    expect(text).toMatch(/^- alice\/app — 1 sessions/m);
    expect(text).toMatch(/^- team\/app — 1 sessions/m);
    const one = handleListProjects(corpus.open(), { query: 'team/app' });
    expect(one).toContain('1 project with conversation history matching "team/app":');
    expect(one).toMatch(/^- team\/app — 1 sessions/m);
    expect(matchRepos(corpus.open(), 'team/app')).toEqual(['git.example.com/team/app']);
    expect(matchRepos(corpus.open(), 'TEAM/app')).toEqual(['git.example.com/team/app']);
  });
});

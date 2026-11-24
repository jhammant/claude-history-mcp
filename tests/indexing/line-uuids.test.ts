import { rmSync, utimesSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../../src/db/database.js';
import { openDatabase } from '../../src/db/database.js';
import { indexFile } from '../../src/indexing/indexer.js';
import { fileStart, uuidKey } from '../../src/indexing/line-keys.js';
import { claudeFormat } from '../../src/formats/claude.js';
import { rebuild } from '../../src/indexing/rebuild.js';
import { sweep, topUp } from '../../src/indexing/sweep.js';
import {
  assistantText, assistantThinking, codexLine, createCorpus, piSession, piUser, rolloutMessage, rolloutMeta, toolResult, toolUse,
  userLine, type Corpus,
} from '../helpers/corpus.js';

// ------------------------------------------------------------------ synthetic streams

const T0 = Date.parse('2026-10-01T09:00:00Z');
const at = (minute: number) => new Date(T0 + minute * 60_000).toISOString();
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
type Line = Record<string, unknown>;
const keyed = (line: object, n: number): Line => ({ ...line, uuid: uid(n) });
const system = (minute: number): Line => ({ type: 'system', subtype: 'note', timestamp: at(minute), uuid: uid(900_000 + minute) });

/**
 * A session's lines: prompts, an assistant turn written as several lines (text, then a call),
 * shell calls (a close command, a commit), thinking, and a non-message line. `base`
 * keeps uuids apart between streams; `minute` places it in time.
 */
function stream(sessionId: string, base: number, minute: number, topic: string): Line[] {
  const o = (m: number) => ({ sessionId, timestamp: at(minute + m) });
  return [
    keyed(userLine(`first prompt about ${topic}`, o(0)), base + 0),
    keyed(assistantText('Let me look.', { ...o(1), id: `${topic}-m1` }), base + 1),
    keyed(toolUse('Bash', { command: 'make close app-a1' }, { ...o(2), id: `${topic}-m1`, toolUseId: `${topic}-t1` }), base + 2),
    keyed(toolResult('✓ Closed app-a1: done', { ...o(3), toolUseId: `${topic}-t1` }), base + 3),
    system(minute + 3),
    keyed(assistantText('Committing now.', { ...o(4), id: `${topic}-m2` }), base + 4),
    keyed(toolUse('Bash', { command: `git commit -m "fix: ${topic}"` }, { ...o(5), id: `${topic}-m2`, toolUseId: `${topic}-t2` }), base + 5),
    keyed(toolResult(`[main abc${base}1234] fix: ${topic}\n 1 file changed`, { ...o(6), toolUseId: `${topic}-t2` }), base + 6),
    keyed(userLine(`second prompt about ${topic} zookeeper`, o(7)), base + 7),
    keyed(assistantThinking('thinking it over', { ...o(8), id: `${topic}-m3` }), base + 8),
    keyed(assistantText(`An answer about ${topic}.`, { ...o(9), id: `${topic}-m3` }), base + 9),
    keyed(toolUse('Read', { file_path: `/work/app/${topic}.ts` }, { ...o(10), id: `${topic}-m3`, toolUseId: `${topic}-t3` }), base + 10),
    keyed(toolResult(`contents of ${topic}`, { ...o(11), toolUseId: `${topic}-t3` }), base + 11),
    keyed(userLine(`third prompt about ${topic}`, o(12)), base + 12),
    keyed(assistantText(`Done with ${topic}.`, { ...o(13), id: `${topic}-m4` }), base + 13),
  ];
}

/** A copy of lines as a fork writes them: the same uuids and timestamps, its own session id. */
const copied = (lines: Line[], sessionId: string): Line[] => lines.map((l) => ({ ...l, sessionId }));

// ------------------------------------------------------------------ what the database holds

interface SessionView {
  id: string;
  message_count: number;
  start_time: number | null;
  end_time: number | null;
  first_prompt: string | null;
  messages: unknown[];
  lines: number;
}

function view(db: DB, ids?: string[]): SessionView[] {
  const sessions = db.prepare('SELECT sid, id, message_count, start_time, end_time, first_prompt FROM sessions ORDER BY id').all() as
    Array<{ sid: number; id: string; message_count: number; start_time: number | null; end_time: number | null; first_prompt: string | null }>;
  return sessions.filter((s) => !ids || ids.includes(s.id)).map(({ sid, ...s }) => ({
    ...s,
    messages: db.prepare(
      `SELECT m.seq, m.role, m.ts, m.tools, t.prose, t.tool_input, t.tool_output FROM messages m JOIN message_text t ON t.id = m.id
       WHERE m.session_sid = ? ORDER BY m.seq`,
    ).all(sid),
    lines: db.prepare('SELECT count(*) FROM line_uuids WHERE session_sid = ?').pluck().get(sid) as number,
  }));
}

const fts = (db: DB, word: string) => db.prepare('SELECT count(*) FROM messages_fts WHERE messages_fts MATCH ?').pluck().get(word) as number;
const owner = (db: DB, n: number) =>
  db.prepare('SELECT s.id FROM line_uuids u JOIN sessions s ON s.sid = u.session_sid WHERE u.uuid = ?').pluck().get(uuidKey(uid(n))) as string | undefined;

/** What one file read in full gives, in a database of its own. */
function reference(write: (corpus: Corpus) => void, ids?: string[]): SessionView[] {
  const corpus = createCorpus();
  try {
    write(corpus);
    sweep(corpus.open());
    return view(corpus.open(), ids);
  } finally {
    corpus.cleanup();
  }
}

const HOME = '-home-u-Github-app';
const BULK = '-mnt-bulk-Github-app';

describe('one Claude line, one row: the same session file under two project paths', () => {
  let corpus: Corpus;
  beforeEach(() => { corpus = createCorpus(); });
  afterEach(() => corpus.cleanup());

  const lines = stream('s1', 0, 0, 'kafka');
  const full = () => reference((c) => c.write(c.sessionPath(HOME, 's1'), lines));

  it('indexes a full copy once, keeps both files recorded, and reads neither again', () => {
    corpus.write(corpus.sessionPath(HOME, 's1'), lines);
    corpus.write(corpus.sessionPath(BULK, 's1'), lines);
    const db = corpus.open();

    const stats = sweep(db);

    const expected = full();
    expect(expected[0].messages.length).toBeGreaterThan(0);
    expect(view(db)).toEqual(expected);
    expect(stats.duplicates).toEqual({ sameSession: 14, otherSession: 0, beforeUpgrade: 0 });
    expect(fts(db, 'zookeeper')).toBe(1);
    expect(db.prepare('SELECT count(*) FROM files').pluck().get()).toBe(2);
    expect(view(db)[0].message_count).toBe(view(db)[0].messages.length);
    // Rebuild order is fixed: the lower path feeds the session and names its project.
    expect(db.prepare("SELECT project FROM sessions WHERE id = 's1'").pluck().get()).toBe(HOME);
    expect(sweep(db).changed).toBe(0);
  });

  it('takes the extra lines from whichever copy is ahead', () => {
    // The /mnt copy was caught mid-growth: it is behind, then it is ahead.
    corpus.write(corpus.sessionPath(HOME, 's1'), lines.slice(0, 9));
    corpus.write(corpus.sessionPath(BULK, 's1'), lines.slice(0, 4));
    const db = corpus.open();
    sweep(db);
    corpus.write(corpus.sessionPath(BULK, 's1'), lines);
    sweep(db);

    expect(view(db)).toEqual(full());
  });

  it('gives the rows of one full read when both copies grow and are read in turn, a line or a few at a time', () => {
    const expected = full();
    // Each schedule: how many lines the copies have at each step, alternating home, bulk, home...
    const schedules = [
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 15],
      [2, 1, 3, 5, 4, 7, 9, 8, 12, 15, 15, 15],
      [3, 0, 3, 7, 10, 7, 10, 15, 11, 15],
      [15, 2, 15, 15],
      [0, 6, 2, 9, 3, 15, 15, 15],
    ];
    for (const schedule of schedules) {
      const c = createCorpus();
      try {
        const home = c.sessionPath(HOME, 's1');
        const bulk = c.sessionPath(BULK, 's1');
        const db = c.open();
        schedule.forEach((count, step) => {
          const path = step % 2 === 0 ? home : bulk;
          c.write(path, lines.slice(0, count));
          if (count > 0) indexFile(db, c.file(path));
        });
        sweep(db);
        expect(view(db), `schedule ${schedule.join(',')}`).toEqual(expected);
        expect(fts(db, 'zookeeper')).toBe(1);
      } finally {
        c.cleanup();
      }
    }
  });

  it('indexes a subagent file under two project paths once', () => {
    const sub = stream('s1', 100, 2, 'helper');
    const one = reference((c) => {
      c.write(c.sessionPath(HOME, 's1'), lines);
      c.write(c.subagentPath(HOME, 's1', 'x1'), sub);
    });
    for (const dir of [HOME, BULK]) {
      corpus.write(corpus.sessionPath(dir, 's1'), lines);
      corpus.write(corpus.subagentPath(dir, 's1', 'x1'), sub);
    }

    sweep(corpus.open());

    expect(view(corpus.open())).toEqual(one);
    expect(view(corpus.open()).map((s) => s.id)).toEqual(['agent-x1@s1', 's1']);
  });

  it('skips a line repeated within one file', () => {
    const repeated = [...lines.slice(0, 8), ...lines.slice(5, 8), ...lines.slice(8)];
    corpus.write(corpus.sessionPath(HOME, 's1'), repeated);

    const stats = sweep(corpus.open());

    expect(view(corpus.open())).toEqual(full());
    expect(stats.duplicates.sameSession).toBe(3);
  });

  it('drops a batch when another file of the session was indexed while it was being read', () => {
    const home = corpus.write(corpus.sessionPath(HOME, 's1'), lines.slice(0, 8));
    const bulk = corpus.write(corpus.sessionPath(BULK, 's1'), lines);
    const db = corpus.open();
    let other: ReturnType<typeof indexFile> | undefined;

    const raced = indexFile(db, corpus.file(home), { beforeCommit: () => { other ??= indexFile(db, corpus.file(bulk)); } });
    sweep(db);

    expect(other?.status).toBe('indexed');
    expect(raced.status).toBe('raced');
    expect(view(db)).toEqual(full());
  });

  it('reads the other copies again when one is replaced, and loses nothing', () => {
    const home = corpus.write(corpus.sessionPath(HOME, 's1'), lines);
    corpus.write(corpus.sessionPath(BULK, 's1'), lines);
    const db = corpus.open();
    sweep(db);
    // The home copy is rewritten shorter: the session starts over from both files.
    rmSync(home);
    corpus.write(home, lines.slice(0, 5));

    const stats = sweep(db);

    // The twin did not change, but the same sweep reads it again from its start.
    expect(stats.reset).toBe(1);
    expect(stats.indexed).toBe(2);
    expect(view(db)).toEqual(full());
    expect(sweep(db).changed).toBe(0);
  });
});

describe('one Claude line, one row: forks and sibling subagents', () => {
  let corpus: Corpus;
  beforeEach(() => { corpus = createCorpus(); });
  afterEach(() => corpus.cleanup());

  const original = stream('orig', 0, 0, 'kafka');
  // A fork that copied the original from its third line, then went on alone.
  const forkOwn = stream('a-fork', 200, 60, 'raft');
  const fork = [...copied(original.slice(2, 9), 'a-fork'), ...forkOwn];

  it('leaves the shared lines with the session that started earlier, whatever the order of ids', () => {
    corpus.write(corpus.sessionPath(HOME, 'orig'), original);
    corpus.write(corpus.sessionPath(HOME, 'a-fork'), fork);
    const db = corpus.open();

    const stats = sweep(db);

    const alone = reference((c) => {
      c.write(c.sessionPath(HOME, 'orig'), original);
      c.write(c.sessionPath(HOME, 'a-fork'), forkOwn.map((l) => ({ ...l })));
    });
    expect(view(db)).toEqual(alone);
    expect(stats.duplicates.otherSession).toBe(6);
    const forkRow = view(db, ['a-fork'])[0];
    expect(forkRow.first_prompt).toBe('first prompt about raft');
    expect(forkRow.start_time).toBe(Date.parse(at(60)));
    // The close command in the copied part is the original's alone: each session holds one call of its own.
    const closes = (id: string) => view(db, [id])[0].messages.filter((m) => (m as { tool_input: string }).tool_input.includes('app-a1')).length;
    expect([closes('orig'), closes('a-fork')]).toEqual([1, 1]);
    expect(owner(db, 2)).toBe('orig');
    expect(fileStart(corpus.sessionPath(HOME, 'a-fork'))).toMatchObject({ first: Date.parse(at(2)), keyed: Date.parse(at(2)) });
  });

  /** A fork as Claude Code writes one: leading lines dated when it was made, then the copy from the first line. */
  const leading = (minute: number, n: number): Line[] => [
    { type: 'queue-operation', operation: 'enqueue', timestamp: at(minute) },
    { type: 'attachment', timestamp: at(minute), uuid: uid(950_000 + n) },
  ];
  const origWithLead = [...leading(0, 1), ...original];
  const lowFork = [...leading(60, 2), ...copied(original.slice(0, 9), 'a-low'), ...stream('a-low', 300, 61, 'raft')];

  it('gives a fork copied from the very first line, with a lower id than its original, nothing it copied: in a sweep and in a rebuild', async () => {
    // Fresh: both files in one sweep.
    corpus.write(corpus.sessionPath(HOME, 'orig'), origWithLead);
    corpus.write(corpus.sessionPath(HOME, 'a-low'), lowFork);
    let db = corpus.open();
    sweep(db);
    expect(owner(db, 0)).toBe('orig');
    expect(view(db, ['a-low'])[0].lines).toBe(14);
    const fresh = view(db);
    db.close();

    // A rebuild of it agrees.
    await rebuild(join(corpus.dataDir, 'history.db'));
    db = openDatabase(join(corpus.dataDir, 'history.db'));
    try {
      expect(view(db)).toEqual(fresh);
    } finally {
      db.close();
    }
  });

  it('gives the same tied fork nothing when it arrives in a later sweep, and a rebuild agrees', async () => {
    corpus.write(corpus.sessionPath(HOME, 'orig'), origWithLead);
    let db = corpus.open();
    sweep(db);
    corpus.write(corpus.sessionPath(HOME, 'a-low'), lowFork);
    sweep(db);
    expect(owner(db, 0)).toBe('orig');
    const incremental = view(db);
    db.close();

    await rebuild(join(corpus.dataDir, 'history.db'));
    db = openDatabase(join(corpus.dataDir, 'history.db'));
    try {
      expect(view(db)).toEqual(incremental);
    } finally {
      db.close();
    }
  });

  it('on an exact tie (the fork copied its leading lines too) keeps the owner the database had; a fresh database goes by id', async () => {
    const exact = [...leading(0, 1), ...copied(original.slice(0, 9), 'a-low'), ...stream('a-low', 300, 61, 'raft')];
    corpus.write(corpus.sessionPath(HOME, 'orig'), origWithLead);
    let db = corpus.open();
    sweep(db);
    corpus.write(corpus.sessionPath(HOME, 'a-low'), exact);
    sweep(db);
    expect(owner(db, 0)).toBe('orig');
    const incremental = view(db);
    db.close();

    await rebuild(join(corpus.dataDir, 'history.db'));
    db = openDatabase(join(corpus.dataDir, 'history.db'));
    try {
      expect(view(db)).toEqual(incremental);
    } finally {
      db.close();
    }

    // No database to ask: the lower id comes first and keeps the shared lines.
    const fresh = createCorpus();
    try {
      fresh.write(fresh.sessionPath(HOME, 'orig'), origWithLead);
      fresh.write(fresh.sessionPath(HOME, 'a-low'), exact);
      sweep(fresh.open());
      expect(owner(fresh.open(), 0)).toBe('a-low');
    } finally {
      fresh.cleanup();
    }
  });

  it("takes a fork's cwd and branch from the copied lines it skipped, but not its first prompt or times", () => {
    const bare = stream('c-fork', 400, 60, 'raft').map(({ cwd: _c, gitBranch: _g, ...rest }) => rest);
    corpus.write(corpus.sessionPath(HOME, 'orig'), original);
    corpus.write(corpus.sessionPath(HOME, 'c-fork'), [...copied(original.slice(2, 9), 'c-fork'), ...bare]);

    sweep(corpus.open());

    expect(corpus.open().prepare("SELECT cwd, git_branch, first_prompt, start_time FROM sessions WHERE id = 'c-fork'").get()).toEqual({
      cwd: '/work/app', git_branch: 'main', first_prompt: 'first prompt about raft', start_time: Date.parse(at(60)),
    });
  });

  describe("a fork's own cwd and branch win over the copied lines'", () => {
    const ctx = "SELECT cwd, git_branch, git_remote, cwd_git FROM sessions WHERE id = 'w-fork'";
    /** The fork's own lines, run in a worktree on another branch. */
    const own = stream('w-fork', 500, 60, 'raft').map((l) => ({ ...l, cwd: '/work/wt', gitBranch: 'feat' }));
    /** What the fork's session holds when only its own lines are read. */
    const ownOnly = () => {
      const c = createCorpus();
      try {
        c.write(c.sessionPath(HOME, 'w-fork'), own);
        sweep(c.open());
        return c.open().prepare(ctx).get();
      } finally {
        c.cleanup();
      }
    };

    it('in one batch', () => {
      corpus.write(corpus.sessionPath(HOME, 'orig'), original);
      corpus.write(corpus.sessionPath(HOME, 'w-fork'), [...copied(original.slice(2, 9), 'w-fork'), ...own]);
      sweep(corpus.open());
      expect(corpus.open().prepare(ctx).get()).toEqual(ownOnly());
      expect(corpus.open().prepare(ctx).get()).toMatchObject({ cwd: '/work/wt', git_branch: 'feat', cwd_git: 1 });
    });

    it('when the copied lines fill the first batch and its own lines come in the next', () => {
      // Six copied prompts of 200 KB each: more than one 1 MB read.
      const big = Array.from({ length: 6 }, (_, i) => keyed(userLine(`padding ${i} ${'x'.repeat(200_000)}`, { sessionId: 'orig', timestamp: at(20 + i) }), 600 + i));
      corpus.write(corpus.sessionPath(HOME, 'orig'), [...original, ...big]);
      const f = corpus.write(corpus.sessionPath(HOME, 'w-fork'), [...copied([...original.slice(2, 9), ...big], 'w-fork'), ...own]);
      const db = corpus.open();
      indexFile(db, corpus.file(corpus.sessionPath(HOME, 'orig')));

      const batches: number[] = [];
      indexFile(db, corpus.file(f), { batchBytes: 1, beforeCommit: () => { batches.push(1); } });

      expect(batches.length).toBeGreaterThan(1);
      expect(db.prepare(ctx).get()).toEqual(ownOnly());
    });

    it('when its own lines come in a later sweep, and a rebuild gives the same', async () => {
      const f = corpus.sessionPath(HOME, 'w-fork');
      corpus.write(corpus.sessionPath(HOME, 'orig'), original);
      corpus.write(f, copied(original.slice(2, 9), 'w-fork'));
      let db = corpus.open();
      sweep(db);
      // Only copied lines so far: they are all it has.
      expect(db.prepare(ctx).get()).toMatchObject({ cwd: '/work/app', git_branch: 'main' });
      corpus.append(f, own);
      sweep(db);
      expect(db.prepare(ctx).get()).toEqual(ownOnly());
      const incremental = db.prepare('SELECT id, cwd, git_branch, git_remote, cwd_git FROM sessions ORDER BY id').all();
      db.close();

      await rebuild(join(corpus.dataDir, 'history.db'));
      db = openDatabase(join(corpus.dataDir, 'history.db'));
      try {
        expect(db.prepare('SELECT id, cwd, git_branch, git_remote, cwd_git FROM sessions ORDER BY id').all()).toEqual(incremental);
      } finally {
        db.close();
      }
    });

    it('keeps the copied values when its own lines never state them, through later sweeps and a rebuild', async () => {
      const bare = stream('w-fork', 400, 60, 'raft').map(({ cwd: _c, gitBranch: _g, ...rest }) => rest);
      const f = corpus.sessionPath(HOME, 'w-fork');
      corpus.write(corpus.sessionPath(HOME, 'orig'), original);
      corpus.write(f, [...copied(original.slice(2, 9), 'w-fork'), ...bare.slice(0, 5)]);
      let db = corpus.open();
      sweep(db);
      corpus.append(f, bare.slice(5));
      sweep(db);
      const incremental = db.prepare(ctx).get();
      expect(incremental).toMatchObject({ cwd: '/work/app', git_branch: 'main', cwd_git: 1 });
      db.close();

      await rebuild(join(corpus.dataDir, 'history.db'));
      db = openDatabase(join(corpus.dataDir, 'history.db'));
      try {
        expect(db.prepare(ctx).get()).toEqual(incremental);
      } finally {
        db.close();
      }
    });
  });

  it('drops a batch whose new lines another session took meanwhile, and the next sweep loses and doubles nothing', () => {
    const f = corpus.write(corpus.sessionPath(HOME, 'a-fork'), fork);
    const o = corpus.write(corpus.sessionPath(HOME, 'orig'), original);
    const db = corpus.open();

    const raced = indexFile(db, corpus.file(f), { beforeCommit: () => { indexFile(db, corpus.file(o)); } });
    expect(raced.status).toBe('raced');
    expect(db.prepare("SELECT count(*) FROM files WHERE path = ?").pluck().get(f)).toBe(0);
    sweep(db);

    expect(owner(db, 2)).toBe('orig');
    expect(db.prepare('SELECT count(*) FROM line_uuids').pluck().get()).toBe(14 + 14);
    expect(view(db)).toEqual(reference((c) => {
      c.write(c.sessionPath(HOME, 'orig'), original);
      c.write(c.sessionPath(HOME, 'a-fork'), forkOwn.map((l) => ({ ...l })));
    }));
  });

  it('a fork that the newest-first top-up reaches before its original keeps the copied lines until a rebuild', async () => {
    const o = corpus.write(corpus.sessionPath(HOME, 'orig'), original);
    const f = corpus.write(corpus.sessionPath(HOME, 'a-fork'), fork);
    utimesSync(o, new Date(T0), new Date(T0));
    utimesSync(f, new Date(T0 + 3_600_000), new Date(T0 + 3_600_000));
    let db = corpus.open();

    expect(topUp(db, 60_000).behind).toBe(0);

    // Known limit: top-up goes newest first, so the fork took the shared lines.
    expect(owner(db, 2)).toBe('a-fork');
    expect(db.prepare('SELECT count(*) FROM line_uuids').pluck().get()).toBe(14 + 14);
    db.close();

    await rebuild(join(corpus.dataDir, 'history.db'));
    db = openDatabase(join(corpus.dataDir, 'history.db'));
    try {
      expect(owner(db, 2)).toBe('orig');
    } finally {
      db.close();
    }
  });

  it('starts a new row after the copied lines instead of joining a row from before them', () => {
    const o = (m: number) => ({ sessionId: 'b-fork', timestamp: at(60 + m) });
    corpus.write(corpus.sessionPath(HOME, 'orig'), original);
    corpus.write(corpus.sessionPath(HOME, 'b-fork'), [
      keyed(userLine('fork prompt', o(0)), 400),
      keyed(toolUse('Bash', { command: 'ls' }, { ...o(1), id: 'fm1', toolUseId: 'ft1' }), 401),
      ...copied(original.slice(0, 4), 'b-fork'),
      keyed(toolResult('listing of the fork', { ...o(2), toolUseId: 'ft1' }), 402),
    ]);

    sweep(corpus.open());

    expect(view(corpus.open(), ['b-fork'])[0].messages).toMatchObject([
      { seq: 0, role: 'user', prose: 'fork prompt' },
      { seq: 1, role: 'assistant', tool_input: 'Bash: ls', tool_output: '' },
      { seq: 2, role: 'tool', tool_output: 'listing of the fork' },
    ]);
  });

  it('gives a fork indexed before its original the shared lines (known limit), and still stores each line once', () => {
    const f = corpus.write(corpus.sessionPath(HOME, 'a-fork'), fork);
    const o = corpus.write(corpus.sessionPath(HOME, 'orig'), original);
    const db = corpus.open();

    indexFile(db, corpus.file(f));
    indexFile(db, corpus.file(o));

    expect(owner(db, 2)).toBe('a-fork');
    expect(owner(db, 0)).toBe('orig');
    expect(db.prepare('SELECT count(*) FROM line_uuids').pluck().get()).toBe(14 + 14);
    expect(fts(db, 'zookeeper')).toBe(2); // the original's second prompt (in the fork's copy) and the fork's own
  });

  it('leaves the shared start of sibling subagents with the first by id', () => {
    const shared = stream('p1', 500, 5, 'probe').slice(0, 4);
    corpus.write(corpus.sessionPath(HOME, 'p1'), stream('p1', 600, 0, 'parent'));
    corpus.write(corpus.subagentPath(HOME, 'p1', 'bb'), [...shared, ...stream('p1', 700, 20, 'beta')]);
    corpus.write(corpus.subagentPath(HOME, 'p1', 'aa'), [...shared, ...stream('p1', 800, 30, 'alpha')]);
    const db = corpus.open();

    const stats = sweep(db);

    expect(owner(db, 500)).toBe('agent-aa@p1');
    expect(stats.duplicates.otherSession).toBe(4);
    const [aa, bb] = view(db, ['agent-aa@p1', 'agent-bb@p1']);
    expect(aa.lines).toBe(4 + 14);
    expect(bb.lines).toBe(14);
    expect(bb.first_prompt).toBe('first prompt about beta');
    expect(bb.message_count).toBe(bb.messages.length);
  });

  it('a session whose every line another session holds keeps a row with no messages', () => {
    corpus.write(corpus.sessionPath(HOME, 'orig'), original);
    corpus.write(corpus.sessionPath(HOME, 'empty-fork'), copied(original.slice(3, 9), 'empty-fork'));
    sweep(corpus.open());
    expect(view(corpus.open(), ['empty-fork'])[0]).toMatchObject({ message_count: 0, start_time: null, first_prompt: null, messages: [], lines: 0 });
    expect(corpus.open().prepare("SELECT count(*) FROM summaries WHERE session_id = 'empty-fork'").pluck().get()).toBe(0);
  });
});

describe('one Claude line, one row: other formats, rebuild and the archive', () => {
  let corpus: Corpus;
  beforeEach(() => { corpus = createCorpus(); });
  afterEach(() => corpus.cleanup());

  it('leaves Codex and pi transcripts as they were (no keys, nothing skipped)', () => {
    const feedLine = (sid: string) => ({ ...codexLine('user', 'the same feed line'), uuid: uid(1), sessionId: sid });
    corpus.write(corpus.codexPath('-work-app', 'codex-one'), [feedLine('codex-one')]);
    corpus.write(corpus.codexPath('-work-app', 'codex-two'), [feedLine('codex-two')]);
    const U = '0199ffff-0000-7000-8000-0000000000c1';
    corpus.write(corpus.rolloutPath('2026-10-01', U), [rolloutMeta(U), rolloutMessage('user', 'rollout prompt')]);
    corpus.write(corpus.piPath('--work-app--', 'p-1'), [piSession('p-1'), piUser('pi prompt')]);
    const db = corpus.open();

    const stats = sweep(db);

    expect(stats.duplicates).toEqual({ sameSession: 0, otherSession: 0, beforeUpgrade: 0 });
    expect(db.prepare('SELECT count(*) FROM line_uuids').pluck().get()).toBe(0);
    expect(db.prepare("SELECT id, message_count FROM sessions ORDER BY id").all()).toEqual([
      { id: 'codex-one', message_count: 1 }, { id: `codex-${U}`, message_count: 1 }, { id: 'codex-two', message_count: 1 },
      { id: 'pi-p-1', message_count: 1 },
    ].sort((a, b) => (a.id < b.id ? -1 : 1)));
  });

  it('builds the same database in a rebuild as sweeps did while the files grew', async () => {
    const original = stream('orig', 0, 0, 'kafka');
    const fork = [...copied(original.slice(2, 9), 'fork'), ...stream('fork', 200, 60, 'raft')];
    const sub = stream('orig', 300, 3, 'helper');
    const home = corpus.sessionPath(HOME, 'orig');
    const bulk = corpus.sessionPath(BULK, 'orig');
    const db = corpus.open();
    corpus.write(home, original.slice(0, 5));
    corpus.write(corpus.subagentPath(HOME, 'orig', 'x1'), sub.slice(0, 6));
    sweep(db);
    corpus.write(bulk, original.slice(0, 9));
    corpus.write(corpus.subagentPath(BULK, 'orig', 'x1'), sub);
    sweep(db);
    corpus.write(home, original);
    corpus.write(corpus.sessionPath(HOME, 'fork'), fork);
    sweep(db);
    const incremental = view(db);
    db.close();

    await rebuild(join(corpus.dataDir, 'history.db'));

    const rebuilt = openDatabase(join(corpus.dataDir, 'history.db'));
    try {
      expect(view(rebuilt)).toEqual(incremental);
    } finally {
      rebuilt.close();
    }
  });

  it('carries an archived session with its lines, so a later copy of them is not indexed again', async () => {
    const original = stream('orig', 0, 0, 'kafka');
    const path = corpus.write(corpus.sessionPath(HOME, 'orig'), original);
    sweep(corpus.open());
    corpus.open().close();
    rmSync(path);

    const stats = await rebuild(join(corpus.dataDir, 'history.db'));
    expect(stats.carriedSessions).toBe(1);
    expect(stats.carriedSharedLines).toBe(0);

    const db = openDatabase(join(corpus.dataDir, 'history.db'));
    try {
      expect(db.prepare('SELECT count(*) FROM line_uuids').pluck().get()).toBe(14);
      const kafka = fts(db, 'kafka');
      corpus.write(corpus.sessionPath(HOME, 'later-fork'), [...copied(original, 'later-fork'), ...stream('later-fork', 200, 60, 'raft')]);
      sweep(db);
      expect(view(db, ['later-fork'])[0].first_prompt).toBe('first prompt about raft');
      expect(view(db, ['later-fork'])[0].lines).toBe(14);
      expect(fts(db, 'kafka')).toBe(kafka);
    } finally {
      db.close();
    }
  });

  it('counts the lines an archived original shares with a fork that a rebuild re-read', async () => {
    const original = stream('orig', 0, 0, 'kafka');
    const path = corpus.write(corpus.sessionPath(HOME, 'orig'), original);
    corpus.write(corpus.sessionPath(HOME, 'fork'), [...copied(original.slice(2, 9), 'fork'), ...stream('fork', 200, 60, 'raft')]);
    sweep(corpus.open());
    corpus.open().close();
    rmSync(path);

    const stats = await rebuild(join(corpus.dataDir, 'history.db'));

    // The fork, read without its original, holds the copied lines; the carried rows keep them too.
    expect(stats.carriedSharedLines).toBe(6);
  });
});

describe('one Claude line, one row: a version 2 database upgraded without a rebuild', () => {
  let corpus: Corpus;
  beforeEach(() => { corpus = createCorpus(); });
  afterEach(() => corpus.cleanup());

  /** Make the database look as v2 left it: rows indexed, no uuids recorded, no v3 objects. */
  function downgradeToV2(db: DB): void {
    db.exec(`DROP TRIGGER messages_ad_line_uuids; DROP TABLE line_uuids; DROP TABLE line_uuid_cutoffs;
             ALTER TABLE sessions DROP COLUMN index_rev; ALTER TABLE sessions DROP COLUMN context_copied; PRAGMA user_version = 2;`);
  }

  it('upgrades a v2 database holding both twins as two blocks: nothing lost before the rebuild, a full read after it', async () => {
    const lines = stream('s1', 0, 0, 'kafka');
    const home = corpus.sessionPath(HOME, 's1');
    const bulk = corpus.sessionPath(BULK, 's1');
    const dbPath = join(corpus.dataDir, 'history.db');
    let db = corpus.open();
    // As v2 indexed them: each twin its own block of rows, with its own tail.
    claudeFormat.uuidLines = false;
    try {
      corpus.write(home, lines.slice(0, 9));
      corpus.write(bulk, lines.slice(0, 7));
      sweep(db);
    } finally {
      claudeFormat.uuidLines = true;
    }
    expect(db.prepare('SELECT count(*) FROM messages').pluck().get()).toBe(4 + 3);
    downgradeToV2(db);
    db.close();

    db = openDatabase(dbPath);
    const tuple = (m: unknown) => {
      const { seq: _s, ts: _t, ...rest } = m as Record<string, unknown>;
      return JSON.stringify(rest);
    };
    const full = reference((c) => c.write(c.sessionPath(HOME, 's1'), lines))[0].messages.map(tuple);
    try {
      corpus.write(home, lines.slice(0, 12));
      corpus.write(bulk, lines);
      sweep(db);
      const have = view(db)[0].messages.map(tuple);
      // Every row of a full read is there; the rows made only of lines written after the upgrade are there once.
      for (const row of full) expect(have).toContain(row);
      for (const row of full.slice(-3)) expect(have.filter((r) => r === row)).toHaveLength(1);
      expect(view(db)[0].message_count).toBe(have.length);
    } finally {
      db.close();
    }

    await rebuild(dbPath);
    db = openDatabase(dbPath);
    try {
      expect(view(db)).toEqual(reference((c) => c.write(c.sessionPath(HOME, 's1'), lines)));
    } finally {
      db.close();
    }
  });

  it('adds new lines once and does not add again the old lines a lagging or new copy carries', () => {
    const lines = stream('s1', 0, 0, 'kafka');
    const home = corpus.write(corpus.sessionPath(HOME, 's1'), lines.slice(0, 9));
    const dbPath = join(corpus.dataDir, 'history.db');
    let db = corpus.open();
    sweep(db);
    downgradeToV2(db);
    db.close();

    db = openDatabase(dbPath);
    try {
      expect(db.pragma('user_version', { simple: true })).toBe(4);
      expect(db.prepare('SELECT count(*) FROM line_uuid_cutoffs').pluck().get()).toBe(1);
      expect(db.prepare('SELECT count(*) FROM line_uuids').pluck().get()).toBe(0);
      // New lines in the copy indexed before the upgrade, then the twin appears with everything.
      corpus.write(home, lines.slice(0, 12));
      sweep(db);
      corpus.write(corpus.sessionPath(BULK, 's1'), lines);
      const stats = sweep(db);

      expect(stats.duplicates).toEqual({ sameSession: 3, otherSession: 0, beforeUpgrade: 8 });
      expect(view(db)).toEqual(reference((c) => c.write(c.sessionPath(HOME, 's1'), lines)));
    } finally {
      db.close();
    }
  });

  it('drops the cutoff and the uuids when the session is read again from scratch', () => {
    const lines = stream('s1', 0, 0, 'kafka');
    const home = corpus.write(corpus.sessionPath(HOME, 's1'), lines);
    const db = corpus.open();
    sweep(db);
    db.prepare("INSERT INTO line_uuid_cutoffs(session_sid, ts) SELECT sid, end_time FROM sessions").run();
    rmSync(home);
    corpus.write(home, lines.slice(0, 3));

    sweep(db);

    expect(db.prepare('SELECT count(*) FROM line_uuid_cutoffs').pluck().get()).toBe(0);
    expect(db.prepare('SELECT count(*) FROM line_uuids').pluck().get()).toBe(3);
  });
});

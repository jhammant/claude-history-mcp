import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Packr } from 'msgpackr';
import { openDatabase } from '../../src/db/database.js';
import { importLegacy } from '../../src/indexing/legacy-import.js';
import { rebuild } from '../../src/indexing/rebuild.js';
import { acquireLock, sweep, SweepBusyError, topUp } from '../../src/indexing/sweep.js';
import { runCommand } from '../../src/cli/commands.js';
import { assistantText, createCorpus, userLine, type Corpus } from '../helpers/corpus.js';

const count = (corpus: Corpus, sql: string, ...params: unknown[]) =>
  (corpus.open().prepare(sql).get(...params) as { n: number }).n;

describe('sweep', () => {
  let corpus: Corpus;
  beforeEach(() => {
    corpus = createCorpus();
    corpus.write(corpus.sessionPath('-work-app', 'a1'), [
      userLine('We decided to use SQLite for the archive', { cwd: '/work/app' }),
      assistantText('Going with SQLite FTS5 because it needs no daemon.', { cwd: '/work/app' }),
    ]);
    corpus.write(corpus.subagentPath('-work-app', 'a1', 'sub1'), [userLine('subagent task: decided to use redis', { sessionId: 'a1' })]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    corpus.cleanup();
  });

  it('indexes everything, then finds nothing to do on a second run', () => {
    // Act
    const first = sweep(corpus.open());
    const second = sweep(corpus.open());

    // Assert
    expect(first).toMatchObject({ transcripts: 2, changed: 2, indexed: 2, messagesAdded: 3, sessions: 2, messages: 3 });
    expect(second).toMatchObject({ changed: 0, messagesAdded: 0, summarized: 0 });
  });

  it('writes summaries and knowledge for top-level sessions only', () => {
    // Act
    sweep(corpus.open());

    // Assert
    expect(count(corpus, 'SELECT count(*) AS n FROM summaries')).toBe(1);
    const topic = JSON.parse((corpus.open().prepare('SELECT data FROM summaries').get() as { data: string }).data).topic;
    expect(topic).toBe('We decided to use SQLite for the archive');
    expect(count(corpus, "SELECT count(*) AS n FROM knowledge WHERE type = 'decision' AND session_id = 'a1'")).toBeGreaterThan(0);
    expect(count(corpus, "SELECT count(*) AS n FROM knowledge WHERE session_id = 'agent-sub1@a1'")).toBe(0);
  });

  it('notices another sweep holding the lock and steps aside', async () => {
    // Arrange: a live process (our parent) holds the lock
    const db = corpus.open();
    db.prepare('INSERT INTO locks(name, pid, acquired) VALUES (?, ?, ?)').run('sweep', process.ppid, Date.now());
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Act / Assert
    expect(() => sweep(db)).toThrow(SweepBusyError);
    expect(await runCommand('sweep', [])).toBe(0);
    expect(String(log.mock.calls[0][0])).toContain('Another sweep');
  });

  it('reclaims free space when much of the file is free pages', () => {
    // Arrange: fill the database, then free most of it
    const db = corpus.open();
    sweep(db);
    db.exec("CREATE TABLE ballast(x); INSERT INTO ballast SELECT randomblob(4000) FROM (WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000) SELECT i FROM n); DROP TABLE ballast;");
    expect(db.pragma('freelist_count', { simple: true })).toBeGreaterThan(1000);

    // Act
    const stats = sweep(db);

    // Assert
    expect(stats.vacuumed).toBe(true);
    expect(db.pragma('freelist_count', { simple: true })).toBe(0);
  });

  it('compacts the file after many new messages, and not when little changed', () => {
    // Arrange
    const db = corpus.open();

    // Act
    const first = sweep(db);
    corpus.append(corpus.sessionPath('-work-app', 'a1'), [userLine('one more', { cwd: '/work/app' })]);
    const oneMore = sweep(db);
    for (let i = 0; i < 40; i++) corpus.write(corpus.sessionPath('-work-app', `bulk-${i}`), [userLine(`bulk ${i}`)]);
    const bulk = sweep(db);

    // Assert
    expect(first.vacuumed).toBe(true);
    expect(oneMore.vacuumed).toBe(true); // 1 of 4 messages is new: over the 10% share
    expect(sweep(db).vacuumed).toBe(false);
    expect(bulk.vacuumed).toBe(true);
  });

  it('takes over a lock whose holder has exited', () => {
    const db = corpus.open();
    db.prepare('INSERT INTO locks(name, pid, acquired) VALUES (?, ?, ?)').run('sweep', 999_999, Date.now());
    expect(acquireLock(db, 'sweep')).toBeNull();
  });

  it('prints one line of totals, or stats with --json, and exits 0', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await runCommand('sweep', ['--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({ indexed: 2, messagesAdded: 3 });
    expect(await runCommand('sweep', [])).toBe(0);
    expect(String(log.mock.calls[1][0])).toMatch(/^Nothing changed in .* s; 2 transcripts on disk, 2 sessions and 3 messages/);
  });
});

describe('query-time top-up', () => {
  let corpus: Corpus;
  beforeEach(() => {
    corpus = createCorpus();
    corpus.write(corpus.sessionPath('-work-app', 'p1'), [userLine('first')]);
    sweep(corpus.open());
  });
  afterEach(() => corpus.cleanup());

  it('reports changed transcripts without indexing them when the budget is 0', () => {
    // Arrange
    corpus.append(corpus.sessionPath('-work-app', 'p1'), [userLine('second')]);
    corpus.write(corpus.sessionPath('-work-app', 'p2'), [userLine('new session')]);

    // Act
    const result = topUp(corpus.open(), 0);

    // Assert
    expect(result).toMatchObject({ indexed: 0, behind: 2 });
    expect(count(corpus, 'SELECT count(*) AS n FROM messages')).toBe(1);
  });

  it('indexes changed transcripts, and the subagents of changed sessions, within the budget', () => {
    // Arrange
    corpus.append(corpus.sessionPath('-work-app', 'p1'), [userLine('second')]);
    corpus.write(corpus.subagentPath('-work-app', 'p1', 'helper'), [userLine('helper work', { sessionId: 'p1' })]);

    // Act
    const result = topUp(corpus.open(), 5_000);

    // Assert
    expect(result).toMatchObject({ indexed: 2, behind: 0 });
    expect(count(corpus, "SELECT count(*) AS n FROM sessions WHERE id = 'agent-helper@p1'")).toBe(1);
  });

  it('indexes the newest transcripts first', () => {
    // Arrange
    const old = corpus.write(corpus.sessionPath('-work-app', 'old'), [userLine('old')]);
    utimesSync(old, new Date('2026-01-01'), new Date('2026-01-01'));
    corpus.write(corpus.sessionPath('-work-app', 'new'), [userLine('new')]);
    const db = corpus.open();
    const order: string[] = [];
    db.function('note_session', (id: string) => { order.push(id); return null; });
    db.exec("CREATE TEMP TRIGGER note AFTER INSERT ON sessions BEGIN SELECT note_session(new.id); END");

    // Act
    topUp(db, 5_000);

    // Assert
    expect(order).toEqual(['new', 'old']);
  });
});

describe('rebuild', () => {
  let corpus: Corpus;
  beforeEach(() => { corpus = createCorpus(); });
  afterEach(() => corpus.cleanup());

  it('builds a fresh database, keeps sessions whose transcripts are gone, and swaps it in under an open reader', async () => {
    // Arrange
    const gone = corpus.write(corpus.sessionPath('-work-app', 'gone'), [userLine('archived wisdom about vacuum')]);
    corpus.write(corpus.sessionPath('-work-app', 'kept'), [userLine('still on disk')]);
    sweep(corpus.open());
    rmSync(gone);
    corpus.write(corpus.sessionPath('-work-app', 'fresh'), [userLine('appeared after the last sweep')]);
    const reader = openDatabase(join(corpus.dataDir, 'history.db'), { readonly: true });
    expect((reader.prepare('SELECT count(*) AS n FROM sessions').get() as { n: number }).n).toBe(2);

    // Act
    const stats = await rebuild(join(corpus.dataDir, 'history.db'));

    // Assert
    expect(stats.carriedSessions).toBe(1);
    expect((reader.prepare('SELECT id FROM sessions ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id))
      .toEqual(['fresh', 'gone', 'kept']);
    expect(reader.prepare("SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'vacuum'").get()).toEqual({ n: 1 });
    reader.close();
    expect(corpus.open().pragma('journal_mode', { simple: true })).toBe('wal');
    expect(corpus.open().pragma('integrity_check', { simple: true })).toBe('ok');
  });
});

describe('import-legacy', () => {
  let corpus: Corpus;
  beforeEach(() => {
    corpus = createCorpus();
    mkdirSync(corpus.dataDir, { recursive: true });
    corpus.write(corpus.sessionPath('-work-app', 'on-disk'), [userLine('a current session', { timestamp: '2026-10-05T10:00:00Z' })]);
    const chunk = (id: number, sessionId: string, text: string, timestamp: number, role = 'mixed') =>
      ({ id, sessionId, project: '-work-app', text, role, timestamp, toolNames: ['Bash'], tokenCount: 3, messageIndex: id });
    const documents = [
      chunk(0, 'on-disk', 'a current session', Date.parse('2026-10-05T10:00:00Z')),
      chunk(1, 'deleted', 'the old fix for the flux capacitor', Date.parse('2026-06-01T10:00:00Z'), 'user'),
      chunk(2, 'deleted', 'second chunk of that session', Date.parse('2026-06-01T11:00:00Z')),
    ];
    const index = { bm25: { postings: {} }, tfidf: {}, documents: { documents, nextId: 3 }, meta: { lastIndexed: {} } };
    writeFileSync(join(corpus.dataDir, 'index.msgpack'), new Packr({ variableMapSize: true }).pack(index));
    mkdirSync(join(corpus.dataDir, 'summaries'));
    writeFileSync(join(corpus.dataDir, 'summaries', 'deleted.json'),
      JSON.stringify({ sessionId: 'deleted', project: '-work-app', endTime: 1, topic: 'old topic' }));
    writeFileSync(join(corpus.dataDir, 'knowledge.json'), JSON.stringify([
      { id: 'k1', type: 'solution', project: '-work-app', sessionId: 'deleted', timestamp: 1, summary: 'recalibrate it',
        details: '', tags: [], relatedFiles: [] },
    ]));
    sweep(corpus.open());
  });
  afterEach(() => corpus.cleanup());

  it('imports sessions without transcripts, summaries and knowledge, and is idempotent', async () => {
    // Arrange
    const oldest = () => (corpus.open().prepare('SELECT min(ts) AS t FROM messages').get() as { t: number }).t;
    const before = oldest();

    // Act
    const first = await importLegacy(corpus.open());
    const second = await importLegacy(corpus.open());

    // Assert
    expect(first).toMatchObject({ chunksInIndex: 3, sessionsInIndex: 2, sessionsImported: 1, rowsImported: 2,
      sessionsSkippedOnDisk: 1, summariesImported: 1, knowledgeImported: 1 });
    expect(second).toMatchObject({ sessionsImported: 0, rowsImported: 0, sessionsSkippedExisting: 1,
      summariesImported: 0, knowledgeImported: 0 });
    expect(oldest()).toBeLessThan(before);
    expect(corpus.open().prepare("SELECT legacy, message_count, first_prompt FROM sessions WHERE id = 'deleted'").get())
      .toEqual({ legacy: 1, message_count: 2, first_prompt: 'the old fix for the flux capacitor' });
    expect(count(corpus, "SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'capacitor'")).toBe(1);
  });
});

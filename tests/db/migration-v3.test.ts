import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { migrate, MIGRATIONS, SCHEMA_VERSION, SchemaTooNewError } from '../../src/db/schema.js';

const names = (db: Database.Database, type: string) =>
  db.prepare('SELECT name FROM sqlite_master WHERE type = ? ORDER BY name').pluck().all(type) as string[];

describe('migration 3: one row per Claude line', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'history-migrate-3-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('is followed by migration 4', () => {
    expect(SCHEMA_VERSION).toBe(4);
  });

  it('takes a fresh database to the latest with the uuid table, its index, the cutoffs and the trigger', () => {
    const db = openDatabase(join(dir, 'history.db'), { create: true });
    expect(db.pragma('user_version', { simple: true })).toBe(4);
    expect(names(db, 'table')).toEqual(expect.arrayContaining(['line_uuids', 'line_uuid_cutoffs']));
    expect(names(db, 'index')).toContain('line_uuids_session');
    expect(names(db, 'trigger')).toContain('messages_ad_line_uuids');
    expect(db.prepare("SELECT name FROM pragma_table_info('sessions')").pluck().all()).toEqual(expect.arrayContaining(['index_rev', 'context_copied']));
    db.close();
  });

  it('takes a version 2 database to 3: no uuids (a rebuild records them), a cutoff per Claude session with messages', () => {
    const db = new Database(join(dir, 'history.db'));
    migrate(db, MIGRATIONS.filter((m) => m.version <= 2));
    const session = db.prepare('INSERT INTO sessions(id, project, source, end_time, message_count) VALUES (?, ?, ?, ?, ?)');
    session.run('with-rows', 'p', 'claude', 5000, 2);
    session.run('empty', 'p', 'claude', null, 0);
    session.run('codex-1', 'p', 'codex', 7000, 3);

    expect(migrate(db)).toEqual([3, 4]);

    expect(db.prepare('SELECT count(*) FROM line_uuids').pluck().get()).toBe(0);
    expect(db.prepare('SELECT s.id, c.ts FROM line_uuid_cutoffs c JOIN sessions s ON s.sid = c.session_sid').all())
      .toEqual([{ id: 'with-rows', ts: 5000 }]);
    expect(db.prepare('SELECT DISTINCT index_rev FROM sessions').pluck().all()).toEqual([0]);
    db.close();
  });

  it('is idempotent when the column already exists', () => {
    const db = new Database(join(dir, 'history.db'));
    migrate(db, MIGRATIONS.filter((m) => m.version <= 2));
    db.exec('ALTER TABLE sessions ADD COLUMN index_rev INTEGER NOT NULL DEFAULT 0');
    expect(migrate(db)).toEqual([3, 4]);
    db.close();
  });

  it('cannot be opened by a build that knows only version 2', () => {
    const db = new Database(join(dir, 'history.db'));
    migrate(db);
    expect(() => migrate(db, MIGRATIONS.filter((m) => m.version <= 2))).toThrow(SchemaTooNewError);
    db.close();
  });

  it("frees a session's lines when its last message is deleted, whichever path deletes it", () => {
    const db = openDatabase(join(dir, 'history.db'), { create: true });
    const sid = Number(db.prepare("INSERT INTO sessions(id, project, source) VALUES ('s', 'p', 'claude')").run().lastInsertRowid);
    const other = Number(db.prepare("INSERT INTO sessions(id, project, source) VALUES ('t', 'p', 'claude')").run().lastInsertRowid);
    for (const [seq, s] of [[0, sid], [1, sid], [0, other]]) {
      const id = db.prepare("INSERT INTO messages(session_sid, seq, role) VALUES (?, ?, 'user')").run(s, seq).lastInsertRowid;
      db.prepare("INSERT INTO message_text(id) VALUES (?)").run(id);
    }
    const uuid = db.prepare('INSERT INTO line_uuids(uuid, session_sid) VALUES (?, ?)');
    uuid.run(Buffer.alloc(16, 1), sid);
    uuid.run(Buffer.alloc(16, 2), other);
    db.prepare('INSERT INTO line_uuid_cutoffs(session_sid, ts) VALUES (?, 1)').run(sid);

    db.prepare('DELETE FROM messages WHERE session_sid = ? AND seq = 0').run(sid);
    expect(db.prepare('SELECT count(*) FROM line_uuids').pluck().get()).toBe(2);
    db.prepare('DELETE FROM messages WHERE session_sid = ?').run(sid);

    expect(db.prepare('SELECT session_sid FROM line_uuids').pluck().all()).toEqual([other]);
    expect(db.prepare('SELECT count(*) FROM line_uuid_cutoffs').pluck().get()).toBe(0);
    db.close();
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DatabaseOutdatedError, openDatabase } from '../../src/db/database.js';
import { migrate, MIGRATIONS, SCHEMA_VERSION, SchemaTooNewError, type Migration } from '../../src/db/schema.js';

describe('schema migrations', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'history-migrate-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('creates a new database at the latest version, in WAL mode', () => {
    // Act
    const db = openDatabase(join(dir, 'history.db'), { create: true });

    // Assert
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    db.close();
  });

  it('does nothing when the database is already current', () => {
    // Arrange
    const db = openDatabase(join(dir, 'history.db'), { create: true });

    // Act
    const applied = migrate(db);

    // Assert
    expect(applied).toEqual([]);
    db.close();
  });

  it('applies only the newer migrations, in order', () => {
    // Arrange
    const db = new Database(join(dir, 'history.db'));
    migrate(db);
    const next: Migration = { version: SCHEMA_VERSION + 1, description: 'test', up: (d) => d.exec('ALTER TABLE sessions ADD COLUMN note TEXT') };

    // Act
    const applied = migrate(db, [...MIGRATIONS, next]);

    // Assert
    expect(applied).toEqual([SCHEMA_VERSION + 1]);
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION + 1);
    expect((db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map((c) => c.name)).toContain('note');
    db.close();
  });

  it('rolls back a failing migration and leaves the version unchanged', () => {
    // Arrange
    const db = new Database(join(dir, 'history.db'));
    migrate(db);
    const broken: Migration = { version: SCHEMA_VERSION + 1, description: 'broken', up: (d) => {
      d.exec('CREATE TABLE half_done (x)');
      throw new Error('boom');
    } };

    // Act / Assert
    expect(() => migrate(db, [...MIGRATIONS, broken])).toThrow('boom');
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'half_done'").get()).toBeUndefined();
    db.close();
  });

  it('refuses a database written by a newer version', () => {
    // Arrange
    const db = new Database(join(dir, 'history.db'));
    db.pragma(`user_version = ${SCHEMA_VERSION + 5}`);

    // Act / Assert
    expect(() => migrate(db)).toThrow(SchemaTooNewError);
    db.close();
  });

  it('upgrades a v1 database: text moves to message_text, FTS gains scope, subagent ids gain their parent', () => {
    // Arrange: a database at v1 with a session, a subagent and a message
    const db = new Database(join(dir, 'history.db'));
    migrate(db, [MIGRATIONS[0]]);
    db.exec(`INSERT INTO sessions(sid, id, project, source) VALUES (1, 'p1', '-work-app', 'claude');
             INSERT INTO sessions(sid, id, project, source, is_subagent, parent_session) VALUES (2, 'agent-x', '-work-app', 'claude', 1, 'p1');
             INSERT INTO messages(session_sid, seq, role, ts, tools, prose, tool_input, tool_output)
               VALUES (2, 0, 'assistant', 1, 'Bash', 'checking the s1 gearbox', 'Bash: ls', 'gearbox.txt');
             INSERT INTO files(path, session_sid, size, mtime, ino) VALUES ('/x.jsonl', 2, 1, 1, 1);`);

    // Act
    const applied = migrate(db);

    // Assert
    expect(applied).toEqual([2]);
    expect(db.prepare('SELECT id FROM sessions ORDER BY sid').pluck().all()).toEqual(['p1', 'agent-x@p1']);
    expect(db.prepare('SELECT prose, tool_output, scope FROM message_text').get())
      .toEqual({ prose: 'checking the s1 gearbox', tool_output: 'gearbox.txt', scope: 's2 rassistant' });
    const match = (expr: string) => db.prepare('SELECT count(*) FROM messages_fts WHERE messages_fts MATCH ?').pluck().get(expr);
    expect(match('{prose tool_input tool_output} : ("gearbox")')).toBe(1);
    expect(match('{prose tool_input tool_output} : ("s2")')).toBe(0);
    expect(match('scope : ("s2") AND scope : ("rassistant")')).toBe(1);
    expect(db.prepare('SELECT pending_tools FROM files').pluck().get()).toBe('');
    db.prepare('DELETE FROM messages').run();
    expect(db.prepare('SELECT count(*) FROM message_text').pluck().get()).toBe(0);
    expect(match('{prose tool_input tool_output} : ("gearbox")')).toBe(0);
    db.close();
  });

  it('makes a server-style open refuse an outdated database instead of migrating it', () => {
    // Arrange
    const path = join(dir, 'history.db');
    const db = new Database(path);
    migrate(db, [MIGRATIONS[0]]);
    db.close();

    // Act / Assert
    expect(() => openDatabase(path, { migrate: false })).toThrow(DatabaseOutdatedError);
    const reopened = new Database(path);
    expect(reopened.pragma('user_version', { simple: true })).toBe(1);
    reopened.close();
  });
});

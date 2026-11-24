import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, MIGRATIONS, SCHEMA_VERSION } from '../../src/db/schema.js';

describe('migration 4: host and repository identity', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'history-migrate-4-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('is the latest migration', () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual([1, 2, 3, 4]);
    expect(SCHEMA_VERSION).toBe(4);
  });

  it('upgrades a schema 3 database with sessions in it', () => {
    const db = new Database(join(dir, 'history.db'));
    migrate(db, MIGRATIONS.filter((m) => m.version <= 3));
    db.prepare("INSERT INTO sessions(id, project, cwd, source) VALUES ('old', '-work-app', '/home/me/app', 'claude')").run();

    expect(migrate(db)).toEqual([4]);

    expect(db.pragma('user_version', { simple: true })).toBe(4);
    expect(db.prepare('SELECT host, git_remote, repo, repo_root, cwd_git FROM sessions').get())
      .toEqual({ host: '', git_remote: null, repo: null, repo_root: null, cwd_git: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM repo_map').get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT name FROM pragma_table_info('repo_map') ORDER BY cid").pluck().all())
      .toEqual(['host', 'dir', 'root', 'remote', 'at']);
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").pluck().all();
    expect(indexes).toEqual(expect.arrayContaining(['sessions_repo', 'sessions_cwd', 'sessions_host']));
    db.close();
  });

  it('is safe to run when a column already exists', () => {
    const db = new Database(join(dir, 'history.db'));
    migrate(db, MIGRATIONS.filter((m) => m.version <= 3));
    db.exec("ALTER TABLE sessions ADD COLUMN host TEXT NOT NULL DEFAULT ''");

    expect(migrate(db)).toEqual([4]);

    expect(db.pragma('user_version', { simple: true })).toBe(4);
    const names = db.prepare("SELECT name FROM pragma_table_info('sessions')").pluck().all() as string[];
    expect(names.filter((c) => c === 'host')).toHaveLength(1);
    db.close();
  });
});

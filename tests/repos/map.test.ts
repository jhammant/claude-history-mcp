import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type DB } from '../../src/db/database.js';
import { loadRepoMaps } from '../../src/repos/map.js';

const line = (o: object) => JSON.stringify(o);
const rows = (db: DB) => db.prepare('SELECT dir, root, remote, at FROM repo_map ORDER BY dir').all();

describe('loadRepoMaps', () => {
  let dir: string;
  let db: DB;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'history-map-'));
    db = openDatabase(join(dir, 'history.db'), { create: true });
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const meta = () => join(dir, 'meta');
  const put = (name: string, lines: string[]) => {
    mkdirSync(join(meta(), ...name.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(join(meta(), name), lines.join('\n') + '\n');
  };

  it('is a no-op for a missing directory', () => {
    expect(loadRepoMaps(db, meta(), 'laptop')).toEqual({ files: 0, entries: 0, changed: false });
  });

  it('stores good lines, ignoring garbage, relative paths and .. segments', () => {
    put('boxa.jsonl', [
      line({ dir: '/w/a-wt', root: '/w/a', remote: 'https://git.example/o/a.git', at: 100 }),
      'not json',
      '[1,2]',
      line({ dir: 'rel/dir', root: '/w/a', remote: null, at: 100 }),
      line({ dir: '/w/x', root: 'rel', remote: null, at: 100 }),
      line({ dir: '/w/../etc', root: '/w/a', remote: null, at: 100 }),
      line({ dir: '/w/y', root: '/w/a/../b', remote: null, at: 100 }),
      line({ dir: '/w/z', root: '/w/z', remote: null, at: 'soon' }),
      line({ dir: '/w/n', root: '/w/n', remote: 42, at: 5 }),
      line({ dir: '/w/b/', root: '/w/b/', remote: null, at: 7 }),
    ]);
    const result = loadRepoMaps(db, meta(), 'laptop');
    expect(result).toEqual({ files: 1, entries: 3, changed: true });
    expect(rows(db)).toEqual([
      { dir: '/w/a-wt', root: '/w/a', remote: 'https://git.example/o/a.git', at: 100 },
      { dir: '/w/b', root: '/w/b', remote: null, at: 7 },
      { dir: '/w/n', root: '/w/n', remote: null, at: 5 },
    ]);
  });

  it('strips credentials before storing', () => {
    put('boxa.jsonl', [line({ dir: '/w/a', root: '/w/a', remote: 'https://user:tok@git.example/o/a.git?x=1', at: 1 })]);
    loadRepoMaps(db, meta(), 'laptop');
    expect(rows(db)).toEqual([{ dir: '/w/a', root: '/w/a', remote: 'https://git.example/o/a.git', at: 1 }]);
  });

  it('keeps the same directory on two hosts apart', () => {
    const dirA = join(dir, 'a');
    const dirB = join(dir, 'b');
    mkdirSync(dirA);
    mkdirSync(dirB);
    writeFileSync(join(dirA, 'laptop.jsonl'), line({ dir: '/home/me/app', root: '/home/me/app', remote: 'https://example.com/acme/app.git', at: 1 }) + '\n');
    writeFileSync(join(dirB, 'desktop.jsonl'), line({ dir: '/home/me/app', root: '/home/me/app', remote: 'https://example.com/acme/other.git', at: 1 }) + '\n');
    loadRepoMaps(db, dirA, 'laptop');
    loadRepoMaps(db, dirB, 'desktop');
    expect(db.prepare("SELECT host, remote FROM repo_map WHERE dir = '/home/me/app' ORDER BY host").all()).toEqual([
      { host: 'desktop', remote: 'https://example.com/acme/other.git' },
      { host: 'laptop', remote: 'https://example.com/acme/app.git' },
    ]);
  });

  it('stores every entry under the host argument, whatever the file is called', () => {
    put('whatever.jsonl', [line({ dir: '/w/a', root: '/w/a', remote: null, at: 1 })]);
    loadRepoMaps(db, meta(), 'desktop');
    expect(db.prepare('SELECT host FROM repo_map').all()).toEqual([{ host: 'desktop' }]);
  });

  it('reads only the named file when given one, and nothing when it is missing or not a regular file', () => {
    put('laptop.jsonl', [line({ dir: '/w/a', root: '/w/a', remote: null, at: 1 })]);
    put('desktop.jsonl', [line({ dir: '/w/b', root: '/w/b', remote: null, at: 1 })]);
    put('sub/laptop.jsonl', [line({ dir: '/w/c', root: '/w/c', remote: null, at: 1 })]);
    expect(loadRepoMaps(db, meta(), 'laptop', { file: 'laptop.jsonl' })).toEqual({ files: 1, entries: 1, changed: true });
    expect(rows(db).map((r) => (r as { dir: string }).dir)).toEqual(['/w/a']);
    expect(loadRepoMaps(db, meta(), 'pc', { file: 'pc.jsonl' })).toEqual({ files: 0, entries: 0, changed: false });
    symlinkSync(join(meta(), 'desktop.jsonl'), join(meta(), 'linked.jsonl'));
    expect(loadRepoMaps(db, meta(), 'linked', { file: 'linked.jsonl' })).toEqual({ files: 0, entries: 0, changed: false });
    mkdirSync(join(meta(), 'dir.jsonl'));
    expect(loadRepoMaps(db, meta(), 'dir', { file: 'dir.jsonl' })).toEqual({ files: 0, entries: 0, changed: false });
  });

  it('strips credentials from a remote in a map line', () => {
    put('boxa.jsonl', [line({ dir: '/w/a', root: '/w/a', remote: 'https://user:tok@example.com/acme/app.git', at: 1 })]);
    loadRepoMaps(db, meta(), 'laptop');
    const stored = db.prepare('SELECT remote FROM repo_map').all();
    expect(stored).toEqual([{ remote: 'https://example.com/acme/app.git' }]);
    expect(JSON.stringify(stored)).not.toContain('tok');
  });

  it('skips a Windows path without failing', () => {
    put('boxa.jsonl', [line({ dir: 'C:\\Users\\me\\app', root: 'C:\\Users\\me\\app', remote: null, at: 1 })]);
    expect(loadRepoMaps(db, meta(), 'laptop')).toEqual({ files: 1, entries: 0, changed: false });
  });

  it('stores a null remote when the remote is not a recognisable URL', () => {
    put('boxa.jsonl', [line({ dir: '/w/a', root: '/w/a', remote: '/srv/git/a.git', at: 1 })]);
    loadRepoMaps(db, meta(), 'laptop');
    expect(rows(db)).toEqual([{ dir: '/w/a', root: '/w/a', remote: null, at: 1 }]);
  });

  it('lets a newer at win, ignores equal or older, and reports no change when reloaded', () => {
    put('boxa.jsonl', [line({ dir: '/w/a', root: '/w/a', remote: null, at: 10 })]);
    expect(loadRepoMaps(db, meta(), 'laptop').changed).toBe(true);
    expect(loadRepoMaps(db, meta(), 'laptop').changed).toBe(false);

    // equal at with the same value is ignored
    put('boxa.jsonl', [line({ dir: '/w/a', root: '/w/a', remote: null, at: 10 })]);
    expect(loadRepoMaps(db, meta(), 'laptop').changed).toBe(false);
    put('boxa.jsonl', [line({ dir: '/w/a', root: '/w/older', remote: null, at: 9 })]);
    expect(loadRepoMaps(db, meta(), 'laptop').changed).toBe(false);
    expect(rows(db)).toEqual([{ dir: '/w/a', root: '/w/a', remote: null, at: 10 }]);

    // equal at with a different value wins (a change within the same second)
    put('boxa.jsonl', [line({ dir: '/w/a', root: '/w/other', remote: null, at: 10 })]);
    expect(loadRepoMaps(db, meta(), 'laptop').changed).toBe(true);
    expect(rows(db)).toEqual([{ dir: '/w/a', root: '/w/other', remote: null, at: 10 }]);
    expect(loadRepoMaps(db, meta(), 'laptop').changed).toBe(false);

    put('boxa.jsonl', [line({ dir: '/w/a', root: '/w/new', remote: null, at: 11 })]);
    expect(loadRepoMaps(db, meta(), 'laptop').changed).toBe(true);
    expect(rows(db)).toEqual([{ dir: '/w/a', root: '/w/new', remote: null, at: 11 }]);
  });

  it('on a tie in one file the later line wins', () => {
    put('boxa.jsonl', [
      line({ dir: '/w/a', root: '/w/first', remote: null, at: 10 }),
      line({ dir: '/w/a', root: '/w/second', remote: null, at: 10 }),
    ]);
    loadRepoMaps(db, meta(), 'laptop');
    expect(rows(db)).toEqual([{ dir: '/w/a', root: '/w/second', remote: null, at: 10 }]);
  });

  it('reports no change when the same file holding a same-second pair is loaded again', () => {
    put('boxa.jsonl', [
      line({ dir: '/w/a', root: '/w/a', remote: null, at: 10 }),
      line({ dir: '/w/a', root: '/w/b', remote: null, at: 10 }),
    ]);
    expect(loadRepoMaps(db, meta(), 'laptop').changed).toBe(true);
    expect(loadRepoMaps(db, meta(), 'laptop').changed).toBe(false);
    expect(loadRepoMaps(db, meta(), 'laptop').changed).toBe(false);
    expect(rows(db)).toEqual([{ dir: '/w/a', root: '/w/b', remote: null, at: 10 }]);
  });

  it('repairs a database holding the earlier line of a same-second pair', () => {
    put('boxa.jsonl', [line({ dir: '/w/a', root: '/w/a', remote: 'https://example.com/o/a.git', at: 10 })]);
    loadRepoMaps(db, meta(), 'laptop');
    put('boxa.jsonl', [
      line({ dir: '/w/a', root: '/w/a', remote: 'https://example.com/o/a.git', at: 10 }),
      line({ dir: '/w/a', root: '/w/a', remote: 'https://example.com/o/b.git', at: 10 }),
    ]);
    expect(loadRepoMaps(db, meta(), 'laptop').changed).toBe(true);
    expect(rows(db)).toEqual([{ dir: '/w/a', root: '/w/a', remote: 'https://example.com/o/b.git', at: 10 }]);
    // and a remote dropped within the same second (NULL-safe comparison)
    put('boxa.jsonl', [line({ dir: '/w/a', root: '/w/a', remote: null, at: 10 })]);
    expect(loadRepoMaps(db, meta(), 'laptop').changed).toBe(true);
    expect(rows(db)).toEqual([{ dir: '/w/a', root: '/w/a', remote: null, at: 10 }]);
  });

  it('merges files from several machines and nested directories, newest line winning', () => {
    put('boxa.jsonl', [line({ dir: '/w/a', root: '/w/a1', remote: null, at: 5 })]);
    put('sub/boxb.jsonl', [line({ dir: '/w/a', root: '/w/a2', remote: null, at: 6 }), line({ dir: '/w/b', root: '/w/b', remote: null, at: 1 })]);
    put('notes.txt', [line({ dir: '/w/c', root: '/w/c', remote: null, at: 1 })]);
    expect(loadRepoMaps(db, meta(), 'laptop')).toEqual({ files: 2, entries: 3, changed: true });
    expect(rows(db).map((r) => (r as { root: string }).root)).toEqual(['/w/a2', '/w/b']);
  });

  it('skips an oversize file without reading it, once-logged, and still loads the others', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    mkdirSync(meta(), { recursive: true });
    const first = line({ dir: '/w/big', root: '/w/big', remote: null, at: 1 }) + '\n';
    writeFileSync(join(meta(), 'big.jsonl'), first + ' '.repeat(8 * 1024 * 1024));
    put('ok.jsonl', [line({ dir: '/w/ok', root: '/w/ok', remote: null, at: 1 })]);
    expect(loadRepoMaps(db, meta(), 'laptop')).toEqual({ files: 1, entries: 1, changed: true });
    expect(rows(db)).toEqual([{ dir: '/w/ok', root: '/w/ok', remote: null, at: 1 }]);
    loadRepoMaps(db, meta(), 'laptop');
    expect(err.mock.calls.filter((c) => String(c[0]).includes('big.jsonl'))).toHaveLength(1);
    err.mockRestore();
  });

  it('ignores a line whose at is more than a day in the future', () => {
    put('boxa.jsonl', [
      line({ dir: '/w/pin', root: '/w/pin', remote: null, at: 1e308 }),
      line({ dir: '/w/far', root: '/w/far', remote: null, at: Date.now() / 1000 + 3 * 86400 }),
      line({ dir: '/w/now', root: '/w/now', remote: null, at: Math.floor(Date.now() / 1000) }),
    ]);
    expect(loadRepoMaps(db, meta(), 'laptop').entries).toBe(1);
    expect(rows(db).map((r) => (r as { dir: string }).dir)).toEqual(['/w/now']);
  });

  it('skips directories and symlinks named *.jsonl', () => {
    mkdirSync(join(meta(), 'x.jsonl'), { recursive: true });
    put('real.jsonl', [line({ dir: '/w/a', root: '/w/a', remote: null, at: 1 })]);
    symlinkSync(join(meta(), 'real.jsonl'), join(meta(), 'link.jsonl'));
    expect(loadRepoMaps(db, meta(), 'laptop')).toEqual({ files: 1, entries: 1, changed: true });
  });

  it('caps files per load and entries per file', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (let i = 0; i < 501; i++) put(`m${i}.jsonl`, [line({ dir: `/w/d${i}`, root: '/w', remote: null, at: 1 })]);
    expect(loadRepoMaps(db, meta(), 'laptop').files).toBe(500);
    rmSync(meta(), { recursive: true });
    const lines = Array.from({ length: 50_005 }, (_, i) => line({ dir: `/w/e${i}`, root: '/w', remote: null, at: 1 }));
    put('many.jsonl', lines);
    expect(loadRepoMaps(db, meta(), 'laptop').entries).toBe(50_000);
    err.mockRestore();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pack } from 'msgpackr';
import { CONFIG } from '../../src/config.js';
import { IndexManager } from '../../src/indexing/index-manager.js';
import { claimWriterLock } from '../../src/indexing/writer-lock.js';
import { IncrementalIndexer } from '../../src/watcher/incremental-indexer.js';
import { KnowledgeStore } from '../../src/knowledge/knowledge-store.js';

const line = (sid: string, text: string) => JSON.stringify({type: 'user', sessionId: sid,
  cwd: '/work/app', timestamp: '2026-10-14T12:00:00Z', message: {role: 'user', content: text}}) + '\n';
const settle = () => new Promise(resolve => setTimeout(resolve, 50));

describe('index lifecycle', () => {
  let root: string, projects: string, data: string;
  const session = (sid: string, text: string) => {
    const file = join(projects, sid + '.jsonl');
    writeFileSync(file, line(sid, text));
    return file;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'history-lifecycle-'));
    projects = join(root, 'projects', '-work-app');
    data = join(root, 'data');
    mkdirSync(projects, {recursive: true});
    mkdirSync(data, {recursive: true});
    vi.spyOn(CONFIG, 'projectRoots', 'get').mockReturnValue([join(root, 'projects')]);
    vi.spyOn(CONFIG, 'indexFile', 'get').mockReturnValue(join(data, 'index.msgpack'));
    vi.spyOn(CONFIG, 'summariesDir', 'get').mockReturnValue(join(root, 'summaries'));
  });
  afterEach(() => { vi.restoreAllMocks(); rmSync(root, {recursive: true, force: true}); });

  it('saves a vocabulary past 65,535 terms as msgpack and loads it back', async () => {
    // Real histories outgrew msgpack's default 16-bit maps: every save fell back to JSON
    // and start-up kept loading a months-old msgpack instead.
    const words = Array.from({length: 70_000}, (_, i) => `term${i.toString(36)}x`);
    session('big', words.join(' '));
    const manager = new IndexManager();
    await manager.buildFullIndex();
    const serialized = (manager as unknown as {bm25: {serialize(): unknown}}).bm25.serialize();
    expect(() => pack(serialized), 'the default packer still rejects this vocabulary').toThrow(/too large/);

    await manager.save();
    expect(existsSync(join(data, 'index.msgpack'))).toBe(true);
    expect(existsSync(join(data, 'index.json'))).toBe(false);
    expect(manager.isDirty).toBe(false);

    const reloaded = new IndexManager();
    expect(await reloaded.load()).toBe(true);
    expect(reloaded.getStats()).toEqual({...manager.getStats(), buildTimeMs: expect.any(Number)});
  }, 60_000);

  it('loads the newer index when a stale file in the other format is still there', async () => {
    session('one', 'first session about queues');
    const stale = new IndexManager();
    await stale.buildFullIndex();
    await stale.save();

    session('two', 'second session about caches');
    const fresh = new IndexManager();
    await fresh.buildFullIndex();
    writeFileSync(join(data, 'index.json'), JSON.stringify({bm25: fresh.bm25.serialize(),
      tfidf: fresh.tfidf.serialize(), documents: fresh.documents.serialize(),
      meta: (fresh as unknown as {meta: unknown}).meta}));
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(data, 'index.msgpack'), old, old);

    const loaded = new IndexManager();
    expect(await loaded.load()).toBe(true);
    expect(loaded.getStats().sessions).toBe(2);
  });

  it('still loads an index written by the old default packer', async () => {
    session('one', 'a session from before the fix');
    const manager = new IndexManager();
    await manager.buildFullIndex();
    writeFileSync(join(data, 'index.msgpack'), pack({bm25: manager.bm25.serialize(),
      tfidf: manager.tfidf.serialize(), documents: manager.documents.serialize(),
      meta: (manager as unknown as {meta: unknown}).meta}));
    const loaded = new IndexManager();
    expect(await loaded.load()).toBe(true);
    expect(loaded.getStats().sessions).toBe(1);
  });

  it('re-indexes one changed file without duplicating it, and skips unchanged ones', async () => {
    const file = session('live', 'opening message about the scheduler');
    const manager = new IndexManager();
    expect(manager.updateFile(file)?.sessionId).toBe('live');
    const docs = manager.getStats().documents;
    expect(manager.updateFile(file), 'unchanged file').toBeNull();

    appendFileSync(file, line('live', 'a later message about retries'));
    const later = new Date(Date.now() + 5_000);
    utimesSync(file, later, later);
    expect(manager.updateFile(file)).not.toBeNull();
    expect(manager.getStats().sessions).toBe(1);
    expect(manager.getStats().documents).toBeGreaterThanOrEqual(docs);
    expect(manager.updateFile(join(projects, 'gone.jsonl'))).toBeNull();
  });

  it('leaves no stale matches after a session is rewritten and re-indexed', () => {
    const file = session('edit', 'zebra crossings and traffic lights');
    const manager = new IndexManager();
    manager.updateFile(file);
    expect(manager.bm25.search(['zebra']).length).toBe(1);
    writeFileSync(file, line('edit', 'traffic lights only now'));
    const later = new Date(Date.now() + 5_000);
    utimesSync(file, later, later);
    manager.updateFile(file);
    expect(manager.bm25.search(['zebra'])).toEqual([]);
    expect(manager.bm25.search(['traffic']).length).toBe(1);
  });

  it('collapses repeated change reports and saves once, not per change', async () => {
    const file = session('busy', 'a busy session about deploys');
    const manager = new IndexManager();
    const update = vi.spyOn(manager, 'updateFile');
    const save = vi.spyOn(manager, 'save');
    const knowledge = new KnowledgeStore();
    vi.spyOn(knowledge, 'save').mockImplementation(() => {});
    const indexer = new IncrementalIndexer(manager, knowledge);

    for (let i = 0; i < 5; i++) indexer.enqueue(file);
    await settle();
    expect(update).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();

    appendFileSync(file, line('busy', 'another deploy'));
    const later = new Date(Date.now() + 5_000);
    utimesSync(file, later, later);
    indexer.enqueue(file);
    await settle();
    expect(update).toHaveBeenCalledTimes(2);
    expect(save, 'the next save waits for the save interval').toHaveBeenCalledOnce();
    indexer.stop();
    expect(save, 'stopping writes what is unsaved').toHaveBeenCalledTimes(2);
  });

  it('lets one live server write the index and replaces one that has exited', () => {
    const lock = join(data, 'index.lock');
    expect(claimWriterLock(lock)).toBe(true);
    expect(claimWriterLock(lock), 'holding it already').toBe(true);
    writeFileSync(lock, String(process.ppid));
    expect(claimWriterLock(lock), 'another live server holds it').toBe(false);
    writeFileSync(lock, '999999');
    expect(claimWriterLock(lock), 'its holder has exited').toBe(true);
  });

  it('unloads the in-memory index and loads it again', async () => {
    session('one', 'a session about logging');
    const manager = new IndexManager();
    await manager.buildFullIndex();
    await manager.save();
    manager.unload();
    expect(manager.getStats().documents).toBe(0);
    expect(await manager.load()).toBe(true);
    expect(manager.getStats().sessions).toBe(1);
  });
});

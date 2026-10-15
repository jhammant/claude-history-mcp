import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CONFIG } from '../../src/config.js';
import { enumerateSessionFiles } from '../../src/parsers/session-parser.js';
import { parseHistoryFile } from '../../src/parsers/history-parser.js';
import { handleGetSessionSummary } from '../../src/tools/get-session-summary.js';
import { IndexManager } from '../../src/indexing/index-manager.js';
import { SearchEngine } from '../../src/search/search-engine.js';
import { FileWatcher } from '../../src/watcher/file-watcher.js';
import { IncrementalIndexer } from '../../src/watcher/incremental-indexer.js';
import { KnowledgeStore } from '../../src/knowledge/knowledge-store.js';
import type { ParsedSession } from '../../src/parsers/session-parser.js';

describe('Codex normalized feed', () => {
  let root: string, feed: string, file: string;
  const sid = 'codex-11111111-1111-4111-8111-111111111111';
  const message = (text: string) => JSON.stringify({type: 'user', sessionId: sid,
    cwd: '/work/codex-api', timestamp: '2026-09-07T12:00:00Z',
    message: {role: 'user', content: text}}) + '\n';
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'history-codex-'));
    feed = join(root, 'feed');
    mkdirSync(join(feed, '-work-codex-api'), {recursive: true});
    file = join(feed, '-work-codex-api', sid + '.jsonl');
    writeFileSync(file, message('Resolve backpressure in the bounded queue'));
    vi.spyOn(CONFIG, 'projectRoots', 'get').mockReturnValue([join(root, 'missing-claude'), feed]);
    vi.spyOn(CONFIG, 'historyFile', 'get').mockReturnValue(join(root, 'missing-history.jsonl'));
    vi.spyOn(CONFIG, 'summariesDir', 'get').mockReturnValue(join(root, 'summaries'));
  });
  afterEach(() => { vi.restoreAllMocks(); rmSync(root, {recursive: true}); });

  it('indexes and searches Codex with no Claude directories present', async () => {
    expect(enumerateSessionFiles()).toHaveLength(1);
    const manager = new IndexManager();
    await manager.buildFullIndex();
    expect(new SearchEngine(manager).search('backpressure').length).toBeGreaterThan(0);
    expect(parseHistoryFile()[0].sessionId).toBe(sid);
    expect(handleGetSessionSummary({session_id: sid})).toContain('backpressure');
    expect(handleGetSessionSummary({project: 'codex-api'})).toContain(sid);
    const before = manager.getStats().documents;
    await manager.incrementalUpdate();
    expect(manager.getStats().documents).toBe(before);
  });

  it('reindexes fresh files after debounce rather than discarding their last update', async () => {
    const manager = new IndexManager();
    const update = vi.spyOn(manager, 'incrementalUpdate');
    vi.spyOn(manager, 'save').mockResolvedValue(undefined);
    const knowledge = new KnowledgeStore();
    vi.spyOn(knowledge, 'save').mockImplementation(() => {});
    const indexer = new IncrementalIndexer(manager, knowledge);
    await (indexer as unknown as {handleFileChange(path: string): Promise<void>}).handleFileChange(file);
    expect(update).toHaveBeenCalledOnce();
    expect(manager.getStats().sessions).toBe(1);
  });

  it('stops reading a long session once the chunk budget is exhausted', () => {
    const session = {messages: [{role: 'user', text: 'word '.repeat(
      CONFIG.indexing.chunkSize * CONFIG.indexing.maxChunksPerSession),
      timestamp: '', toolNames: [], toolInputSnippets: []}]} as unknown as ParsedSession;
    Object.defineProperty(session.messages, 1, {get() {
      throw new Error('Read past the session chunk budget');
    }});
    const manager = new IndexManager() as unknown as {chunkSession(s: ParsedSession): unknown[]};
    expect(manager.chunkSession(session)).toHaveLength(CONFIG.indexing.maxChunksPerSession);
  });

  it('watches the feed root and emits an absolute path', async () => {
    const watcher = new FileWatcher(20);
    try {
      const result = new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('watch timed out')), 7000);
        watcher.start(path => {clearTimeout(timeout); resolve(path);});
        writeFileSync(file, message('A resumed turn needs flow control'));
      });
      expect(await result).toBe(file);
    } finally { watcher.stop(); }
  }, 10000);
});

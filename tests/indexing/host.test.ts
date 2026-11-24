import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONFIG, cleanHostName } from '../../src/config.js';
import { indexFile } from '../../src/indexing/indexer.js';
import { sweep } from '../../src/indexing/sweep.js';
import { formatSearchResponse, hostCount } from '../../src/search/format.js';
import { SearchEngine } from '../../src/search/search-engine.js';
import { assistantText, createCorpus, userLine, type Corpus } from '../helpers/corpus.js';

describe('cleanHostName', () => {
  it('cleans host names', () => {
    expect(cleanHostName('laptop.local')).toBe('laptop.local'); // an explicit setting keeps its dots
    expect(cleanHostName('my laptop/../x')).toBe('my_laptop_.._x');
    expect(cleanHostName('-rf')).toBe('_rf');
    expect(cleanHostName('.hidden')).toBe('_hidden');
    expect(cleanHostName('')).toBe('localhost');
    expect(cleanHostName('a'.repeat(80))).toHaveLength(64);
    expect(cleanHostName('Laptop')).toBe('Laptop');
  });
});

describe('the host of a session', () => {
  let corpus: Corpus;
  const hostOf = (id: string) =>
    corpus.open().prepare('SELECT host FROM sessions WHERE id = ?').pluck().get(id) as string | undefined;
  const file = (id: string) => {
    const path = corpus.sessionPath('-work-app', id);
    corpus.write(path, [userLine('hello zebra')]);
    return { path, transcript: corpus.file(path) };
  };
  const append = (path: string) => corpus.append(path, [assistantText('more words')]);
  let savedHost: string | undefined;

  beforeEach(() => { corpus = createCorpus(); savedHost = process.env.CLAUDE_HISTORY_HOST; });
  afterEach(() => {
    if (savedHost === undefined) delete process.env.CLAUDE_HISTORY_HOST; else process.env.CLAUDE_HISTORY_HOST = savedHost;
    corpus.cleanup();
  });

  it('defaults to the short hostname and honours CLAUDE_HISTORY_HOST', () => {
    process.env.CLAUDE_HISTORY_HOST = 'my box/1';
    expect(CONFIG.host).toBe('my_box_1');
    delete process.env.CLAUDE_HISTORY_HOST;
    expect(CONFIG.host).not.toContain('.');
    expect(CONFIG.host).toMatch(/^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/);
  });

  it('reads the other settings', () => {
    expect(CONFIG.repoMapDir).toBe(`${CONFIG.dataDir}/repo-map`);
    expect(CONFIG.worktreeDirs).toEqual(['.worktrees', 'worktrees']);
    process.env.CLAUDE_HISTORY_WORKTREE_DIRS = ' wt, a/b ,, .., x ';
    try { expect(CONFIG.worktreeDirs).toEqual(['wt', 'x']); } finally { delete process.env.CLAUDE_HISTORY_WORKTREE_DIRS; }
    expect(CONFIG.repoHostAliases).toBeUndefined();
  });

  it('records the host when a session is first indexed', () => {
    const { transcript } = file('s1');
    indexFile(corpus.open(), transcript, { host: 'laptop' });
    expect(hostOf('s1')).toBe('laptop');
  });

  it('uses the configured host when none is passed', () => {
    process.env.CLAUDE_HISTORY_HOST = 'desktop';
    const { transcript } = file('s1');
    indexFile(corpus.open(), transcript);
    expect(hostOf('s1')).toBe('desktop');
  });

  it('keeps the first host when the same session file arrives from a second one', () => {
    const { path, transcript } = file('s1');
    indexFile(corpus.open(), transcript, { host: 'laptop' });
    append(path);
    indexFile(corpus.open(), corpus.file(path), { host: 'desktop' });
    expect(hostOf('s1')).toBe('laptop');
  });

  it("fills an empty host the next time the session's file is indexed", () => {
    const { path, transcript } = file('s1');
    indexFile(corpus.open(), transcript, { host: 'laptop' });
    corpus.open().prepare("UPDATE sessions SET host = '' WHERE id = 's1'").run();
    append(path);
    indexFile(corpus.open(), corpus.file(path), { host: 'desktop' });
    expect(hostOf('s1')).toBe('desktop');
  });

  it('filters search by host and treats host:unknown as the empty host', () => {
    const a = file('s1');
    const b = file('s2');
    indexFile(corpus.open(), a.transcript, { host: 'laptop' });
    indexFile(corpus.open(), b.transcript, { host: 'laptop' });
    corpus.open().prepare("UPDATE sessions SET host = '' WHERE id = 's2'").run();
    const engine = new SearchEngine(corpus.open());
    expect(engine.search('zebra host:laptop').hits.map((h) => h.sessionId)).toEqual(['s1']);
    expect(engine.search('zebra host:LAPTOP').hits.map((h) => h.sessionId)).toEqual(['s1']);
    expect(engine.search('zebra host:unknown').hits.map((h) => h.sessionId)).toEqual(['s2']);
  });

  it('shows the host on result lines only when more than one host is known', () => {
    const a = file('s1');
    const b = file('s2');
    indexFile(corpus.open(), a.transcript, { host: 'laptop' });
    indexFile(corpus.open(), b.transcript, { host: 'laptop' });
    const engine = new SearchEngine(corpus.open());
    expect(hostCount(corpus.open())).toBe(1);
    expect(formatSearchResponse(engine.search('zebra'), 'zebra')).not.toContain('@');

    corpus.open().prepare("UPDATE sessions SET host = '' WHERE id = 's2'").run();
    expect(hostCount(corpus.open())).toBe(1); // the empty host is not a host
    corpus.open().prepare("UPDATE sessions SET host = 'desktop' WHERE id = 's1'").run();
    corpus.open().prepare("INSERT INTO sessions(id, project, source, host) VALUES ('s3', '-x', 'claude', 'laptop')").run();
    expect(hostCount(corpus.open())).toBe(2);
    const out = formatSearchResponse(engine.search('zebra'), 'zebra');
    expect(out).toContain(' @desktop');
    expect(out).toContain(' @unknown');
  });

  it('sweeps with the configured host', () => {
    process.env.CLAUDE_HISTORY_HOST = 'laptop';
    file('s1');
    sweep(corpus.open());
    expect(hostOf('s1')).toBe('laptop');
  });
});

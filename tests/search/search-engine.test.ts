import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sweep } from '../../src/indexing/sweep.js';
import { SearchEngine } from '../../src/search/search-engine.js';
import { formatSearchResponse } from '../../src/search/format.js';
import {
  assistantText, codexLine, createCorpus, resetClock, toolResult, toolUse, userLine, type Corpus,
} from '../helpers/corpus.js';

describe('SearchEngine', () => {
  let corpus: Corpus;
  let engine: SearchEngine;

  beforeEach(() => {
    corpus = createCorpus();
    resetClock('2026-09-01T09:00:00Z');
    // 30 sessions in a noisy project that all mention "timeout"...
    for (let i = 0; i < 30; i++) {
      corpus.write(corpus.sessionPath('-work-noisy', `noisy-${i}`), [
        userLine(`timeout timeout timeout in the noisy service, attempt ${i}`, { cwd: '/work/noisy' }),
      ]);
    }
    // ...and one older session in another project.
    corpus.write(corpus.sessionPath('-work-quiet', 'quiet-1'), [
      userLine('why does the payment worker hit a timeout?', { cwd: '/work/quiet', timestamp: '2026-08-01T10:00:00Z' }),
      assistantText('The pool was exhausted. I raised maxConnections and the timeout went away; that fixed it.',
        { cwd: '/work/quiet', timestamp: '2026-08-01T10:01:00Z' }),
      userLine('great, now write the changelog', { cwd: '/work/quiet', timestamp: '2026-08-01T10:02:00Z' }),
    ]);
    corpus.write(corpus.sessionPath('-work-tools', 'tools-1'), [
      userLine('load the old index', { cwd: '/work/tools' }),
      toolUse('Bash', { command: 'node scripts/load.js ~/.data/index.msgpack' }, { cwd: '/work/tools', id: 'a1' }),
      toolResult('Error: ERR_SQLITE_ERROR while opening src/server.ts', { cwd: '/work/tools' }),
    ]);
    corpus.write(corpus.codexPath('-work-codex-api', 'codex-1'), [
      codexLine('user', 'Resolve backpressure in the bounded queue', { sessionId: 'codex-1', cwd: '/work/codex-api' }),
    ]);
    // A long session whose only mention of the word comes after many messages.
    const long = Array.from({ length: 600 }, (_, i) => userLine(`filler message ${i} about nothing much`, { cwd: '/work/long' }));
    long.push(userLine('finally the word quokka appears', { cwd: '/work/long' }));
    corpus.write(corpus.sessionPath('-work-long', 'long-1'), long);
    sweep(corpus.open());
    engine = new SearchEngine(corpus.open());
  });
  afterEach(() => corpus.cleanup());

  it('applies filters in SQL before the limit, so a filtered search keeps its real matches', () => {
    // Act
    const response = engine.search('timeout project:quiet', { limit: 3 });

    // Assert
    expect(response.hits.map((h) => h.sessionId)).toEqual(['quiet-1']);
    expect(response.hits[0].otherHits).toBe(1);
  });

  it('applies role, source, session and date filters', () => {
    expect(engine.search('timeout role:assistant').hits.map((h) => h.sessionId)).toEqual(['quiet-1']);
    expect(engine.search('backpressure source:codex').hits.map((h) => h.sessionId)).toEqual(['codex-1']);
    expect(engine.search('backpressure source:claude').hits).toEqual([]);
    expect(engine.search('timeout session:quiet').hits.map((h) => h.sessionId)).toEqual(['quiet-1']);
    expect(engine.search('timeout before:2026-08-15').hits.map((h) => h.sessionId)).toEqual(['quiet-1']);
    expect(engine.search('tool:Bash msgpack').hits.map((h) => h.sessionId)).toEqual(['tools-1']);
  });

  it('groups hits by session and limits sessions, not messages', () => {
    // Act
    const response = engine.search('timeout', { limit: 5 });

    // Assert
    expect(response.hits).toHaveLength(5);
    expect(new Set(response.hits.map((h) => h.sessionId)).size).toBe(5);
  });

  it('builds the snippet around the matched words, not the start of the message', () => {
    // Act
    const [hit] = engine.search('quokka').hits;

    // Assert
    expect(hit.sessionId).toBe('long-1');
    expect(hit.seq).toBe(600);
    expect(hit.snippet).toContain('**quokka**');
  });

  it('finds identifiers, file names and error codes in tool activity', () => {
    for (const query of ['index.msgpack', 'ERR_SQLITE_ERROR', 'src/server.ts']) {
      const [hit] = engine.search(query).hits;
      expect(hit?.sessionId, query).toBe('tools-1');
    }
    const [hit] = engine.search('ERR_SQLITE_ERROR').hits;
    expect(hit.field).toBe('tool_output');
    expect(hit.snippet).toContain('**ERR_SQLITE_ERROR**');
  });

  it('falls back to a looser match when all terms together find too few', () => {
    // Act
    const response = engine.search('payment worker kangaroo');

    // Assert
    expect(response.hits[0].sessionId).toBe('quiet-1');
    expect(response.hits[0].partial).toBe(true);
    expect(formatSearchResponse(response, 'payment worker kangaroo')).toContain('partial');
  });

  it('ranks loose hits by how much of the query they match', () => {
    // Act: "pool exhausted" both match quiet-1; only "timeout" matches the noisy sessions
    const response = engine.search('pool exhausted timeout zzzunknown');

    // Assert
    expect(response.hits[0].sessionId).toBe('quiet-1');
    expect(response.hits.every((h) => h.partial)).toBe(true);
  });

  it('matches a prefix of the last term in the loose pass', () => {
    expect(engine.search('backpress').hits.map((h) => h.sessionId)).toEqual(['codex-1']);
  });

  it('includes the messages before and after a hit when asked', () => {
    // Act
    const [hit] = engine.search('maxConnections', { includeContext: true }).hits;

    // Assert
    expect(hit.before?.text).toContain('payment worker');
    expect(hit.after?.text).toContain('changelog');
  });

  it('boosts the current project over an otherwise equal hit', () => {
    // Arrange
    const at = '2026-09-10T10:00:00Z';
    corpus.write(corpus.sessionPath('-work-alpha', 'alpha-1'), [userLine('flaky wombat test', { cwd: '/work/alpha', timestamp: at })]);
    corpus.write(corpus.sessionPath('-work-beta', 'beta-1'), [userLine('flaky wombat test', { cwd: '/work/beta', timestamp: at })]);
    sweep(corpus.open());

    // Act
    const forAlpha = engine.search('wombat', { currentProject: '-work-alpha' }).hits.map((h) => h.sessionId);
    const forBeta = engine.search('wombat', { currentProject: '-work-beta' }).hits.map((h) => h.sessionId);

    // Assert
    expect(forAlpha).toEqual(['alpha-1', 'beta-1']);
    expect(forBeta).toEqual(['beta-1', 'alpha-1']);
  });

  it('sorts by recency when asked', () => {
    const hits = engine.search('timeout', { sort: 'recent', limit: 50 }).hits;
    const times = hits.map((h) => h.ts ?? 0);
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('lists recent messages for a filters-only query and reports an empty one', () => {
    expect(engine.search('project:codex-api').hits.map((h) => h.sessionId)).toEqual(['codex-1']);
    expect(engine.search('   ').empty).toBe(true);
  });

  it('formats compact results with the session id and message number', () => {
    const text = formatSearchResponse(engine.search('maxConnections'), 'maxConnections', 'index: 2 changed transcripts not yet indexed');
    expect(text).toContain('1. /work/quiet · 2026-08-01');
    expect(text).toContain('session quiet-1 · assistant #1');
    expect(text).toContain('**maxConnections**');
    expect(text).toContain('index: 2 changed transcripts not yet indexed');
    expect(text).not.toContain('{');
  });
});

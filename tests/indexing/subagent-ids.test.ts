import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sweep } from '../../src/indexing/sweep.js';
import { SearchEngine } from '../../src/search/search-engine.js';
import { readSession } from '../../src/sessions/read-session.js';
import { createCorpus, userLine, type Corpus } from '../helpers/corpus.js';

describe('subagents with the same file name under two parents', () => {
  let corpus: Corpus;
  beforeEach(() => {
    corpus = createCorpus();
    for (const parent of ['parent-aaaa', 'parent-bbbb']) {
      corpus.write(corpus.sessionPath('-work-app', parent), [userLine(`${parent} opening`, { sessionId: parent })]);
      corpus.write(corpus.subagentPath('-work-app', parent, 'dup0001'), [userLine(`helper work for ${parent} on the gearbox`, { sessionId: parent })]);
    }
    sweep(corpus.open());
  });
  afterEach(() => corpus.cleanup());

  it('stores them as two sessions, each linked to its own parent', () => {
    // Act
    const rows = corpus.open().prepare('SELECT id, parent_session, message_count FROM sessions WHERE is_subagent = 1 ORDER BY id').all();

    // Assert
    expect(rows).toEqual([
      { id: 'agent-dup0001@parent-aaaa', parent_session: 'parent-aaaa', message_count: 1 },
      { id: 'agent-dup0001@parent-bbbb', parent_session: 'parent-bbbb', message_count: 1 },
    ]);
  });

  it('filters with session: by the subagent id or by the parent id', () => {
    const engine = new SearchEngine(corpus.open());
    const ids = (q: string) => engine.search(q).hits.map((h) => h.sessionId).sort();
    expect(ids('gearbox session:agent-dup0001')).toEqual(['agent-dup0001@parent-aaaa', 'agent-dup0001@parent-bbbb']);
    expect(ids('gearbox session:agent-dup0001@parent-bbbb')).toEqual(['agent-dup0001@parent-bbbb']);
    expect(ids('gearbox session:parent-aaaa')).toEqual(['agent-dup0001@parent-aaaa']);
  });

  it('opens either one with read_session, and asks which when the short id is ambiguous', () => {
    const db = corpus.open();
    expect(readSession(db, { session_id: 'agent-dup0001@parent-bbbb' })).toContain('helper work for parent-bbbb');
    expect(readSession(db, { session_id: 'parent-aaaa' })).toContain('Subagents: 1');
    const ambiguous = readSession(db, { session_id: 'agent-dup0001' });
    expect(ambiguous).toContain('agent-dup0001@parent-aaaa');
    expect(ambiguous).toContain('agent-dup0001@parent-bbbb');
  });
});

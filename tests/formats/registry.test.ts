import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCorpus, type Corpus } from '../helpers/corpus.js';
import { FORMATS, formatOf } from '../../src/formats/registry.js';
import { listTranscripts } from '../../src/parsers/transcript-files.js';

describe('format registry', () => {
  let corpus: Corpus;
  beforeEach(() => { corpus = createCorpus(); });
  afterEach(() => corpus.cleanup());

  it('registers claude, the codex feed, the codex rollouts and pi', () => {
    expect(FORMATS.map((f) => f.id)).toEqual(['claude', 'codex-feed', 'codex-rollout', 'pi']);
  });

  it('lists each format with its own format id', () => {
    const line = [{ type: 'user', message: { role: 'user', content: 'hi' } }];
    const session = corpus.write(corpus.sessionPath('-work-app', 's1'), line);
    const sub = corpus.write(corpus.subagentPath('-work-app', 's1', 'a1'), line);
    const feed = corpus.write(corpus.codexPath('-work-app', 'codex-c1'), line);
    const files = listTranscripts();
    const by = new Map(files.map((f) => [f.path, f]));
    expect(files).toHaveLength(3);
    expect(by.get(session)).toMatchObject({ source: 'claude', format: 'claude', sessionId: 's1', projectDir: '-work-app', isSubagent: false });
    expect(by.get(sub)).toMatchObject({ source: 'claude', format: 'claude', sessionId: 'agent-a1@s1', projectDir: '-work-app', isSubagent: true });
    expect(by.get(feed)).toMatchObject({ source: 'codex', format: 'codex-feed', sessionId: 'codex-c1', projectDir: '-work-app', isSubagent: false });
  });

  it('translates Claude lines by identity', () => {
    const file = corpus.file(corpus.write(corpus.sessionPath('-p', 's'), [{ type: 'user' }]));
    const obj = { type: 'user' };
    const out = formatOf('claude').translator(file, false).translate(obj);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(obj);
  });
});

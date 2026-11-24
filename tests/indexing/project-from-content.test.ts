import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { indexFile } from '../../src/indexing/indexer.js';
import { FORMATS } from '../../src/formats/registry.js';
import type { FormatId, TranscriptFormat } from '../../src/formats/types.js';
import type { TranscriptFile } from '../../src/parsers/transcript-files.js';
import { UNKNOWN_PROJECT } from '../../src/utils/path-encoder.js';
import { createCorpus, type Corpus } from '../helpers/corpus.js';

const fake: TranscriptFormat = {
  id: 'fake-content' as FormatId,
  source: 'codex',
  root: () => '',
  projectFromContent: true,
  list: () => [],
  isMessageLine: () => true,
  translator: () => ({ translate: (obj) => [obj] }),
};

describe('project taken from the working directory in content', () => {
  let corpus: Corpus;
  beforeEach(() => { corpus = createCorpus(); FORMATS.push(fake); });
  afterEach(() => { FORMATS.splice(FORMATS.indexOf(fake), 1); corpus.cleanup(); });

  const line = (text: string, cwd?: string) => ({
    type: 'user', sessionId: 's1', timestamp: '2026-01-01T00:00:00.000Z', ...(cwd ? { cwd } : {}),
    message: { role: 'user', content: text },
  });
  const fileFor = (path: string): TranscriptFile => {
    const real = corpus.file(path);
    return { ...real, format: fake.id, projectDir: UNKNOWN_PROJECT };
  };
  const project = () =>
    (corpus.open().prepare('SELECT project FROM sessions WHERE id = ?').get('s1') as { project: string }).project;
  const make = (lines: object[]) => {
    mkdirSync(join(corpus.projects, '-x'), { recursive: true });
    return corpus.write(corpus.sessionPath('-x', 's1'), lines);
  };

  it('sets the project from the first cwd seen', () => {
    const path = make([line('hello there', '/work/app.v2')]);
    indexFile(corpus.open(), fileFor(path));
    expect(project()).toBe('-work-app-v2');
  });

  it('stays unknown when no line carries a cwd', () => {
    const path = make([line('hello there')]);
    indexFile(corpus.open(), fileFor(path));
    expect(project()).toBe(UNKNOWN_PROJECT);
  });

  it('does not change once resolved, even on a resumed read with another cwd', () => {
    const path = make([line('hello there', '/work/app.v2')]);
    indexFile(corpus.open(), fileFor(path));
    corpus.append(path, [line('second', '/elsewhere')]);
    indexFile(corpus.open(), fileFor(path));
    expect(project()).toBe('-work-app-v2');
  });

  it('stays unknown when the cwd encodes to nothing (the filesystem root)', () => {
    const path = make([line('hello there', '/')]);
    indexFile(corpus.open(), fileFor(path));
    expect(project()).toBe(UNKNOWN_PROJECT);
  });

  it('resolves on a later batch when the first had no cwd', () => {
    const path = make([line('hello there')]);
    indexFile(corpus.open(), fileFor(path));
    corpus.append(path, [line('second', '/late/dir')]);
    indexFile(corpus.open(), fileFor(path));
    expect(project()).toBe('-late-dir');
  });

  it('keeps the project when a later batch of the same read brings another cwd', () => {
    const path = make([line('hello there', '/work/app.v2'), line('second', '/elsewhere'), line('third', '/elsewhere/too')]);
    const result = indexFile(corpus.open(), fileFor(path), { batchBytes: 1 });
    expect(result.messagesAdded).toBe(3);
    expect(project()).toBe('-work-app-v2');
  });
});

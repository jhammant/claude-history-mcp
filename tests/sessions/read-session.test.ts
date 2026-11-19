import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'fs';
import { sweep } from '../../src/indexing/sweep.js';
import { readSession } from '../../src/sessions/read-session.js';
import { assistantText, createCorpus, userLine, type Corpus } from '../helpers/corpus.js';

describe('read_session', () => {
  let corpus: Corpus;
  let path: string;

  beforeEach(() => {
    corpus = createCorpus();
    const lines = Array.from({ length: 60 }, (_, i) => (i % 2 === 0
      ? userLine(`question ${i}`, { cwd: '/work/reader' })
      : assistantText(`answer ${i}`, { cwd: '/work/reader' })));
    path = corpus.write(corpus.sessionPath('-work-reader', '0f3c9a2e-reader'), lines);
    sweep(corpus.open());
  });
  afterEach(() => corpus.cleanup());

  it('pages around a message number', () => {
    // Act
    const text = readSession(corpus.open(), { session_id: '0f3c9a2e-reader', around: 30, limit: 5 });

    // Assert
    expect(text).toContain('Showing #28–#32 of #0–#59');
    expect(text).toContain('#30 user');
    expect(text).toContain('question 30');
    expect(text).not.toContain('question 26');
    expect(text).toContain('later: from=33');
  });

  it('reads a range, by a unique id prefix', () => {
    const text = readSession(corpus.open(), { session_id: '0f3c9a', from: 0, to: 2 });
    expect(text).toContain('#0 user');
    expect(text).toContain('#2 user');
    expect(text).not.toContain('#3 assistant');
  });

  it('caps characters per message', () => {
    corpus.append(path, [userLine('word '.repeat(1000).trim(), { cwd: '/work/reader' })]);
    sweep(corpus.open());
    const text = readSession(corpus.open(), { session_id: '0f3c9a2e-reader', from: 60, max_chars: 300 });
    expect(text).toContain('[4699 more chars]');
  });

  it('reads a session whose transcript file is gone', () => {
    // Arrange
    rmSync(path);
    sweep(corpus.open());

    // Act
    const text = readSession(corpus.open(), { session_id: '0f3c9a2e-reader', from: 0, limit: 2 });

    // Assert
    expect(text).toContain('transcript deleted, kept in the database');
    expect(text).toContain('question 0');
  });

  it('says so for an unknown session', () => {
    expect(readSession(corpus.open(), { session_id: 'nope' })).toContain('No session "nope"');
  });
});

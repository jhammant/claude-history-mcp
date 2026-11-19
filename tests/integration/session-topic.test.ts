import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sweep } from '../../src/indexing/sweep.js';
import { assistantText, createCorpus, userLine, type Corpus } from '../helpers/corpus.js';

describe('session topic and first prompt', () => {
  let corpus: Corpus;

  beforeEach(() => {
    corpus = createCorpus();
  });
  afterEach(() => corpus.cleanup());

  it('skip a local slash-command wrapper and use what the user asked', () => {
    // Arrange
    corpus.write(corpus.sessionPath('-work-shop', '7a11-topic'), [
      userLine('<command-name>/model</command-name>\n<command-message>model</command-message>', { cwd: '/work/shop' }),
      userLine('<local-command-stdout>Set model to opus</local-command-stdout>', { cwd: '/work/shop' }),
      userLine('why does the checkout page time out', { cwd: '/work/shop' }),
      assistantText('The payment call has no timeout.', { cwd: '/work/shop' }),
    ]);
    const db = corpus.open();

    // Act
    sweep(db);

    // Assert
    const session = db.prepare('SELECT first_prompt FROM sessions WHERE id = ?').get('7a11-topic') as { first_prompt: string };
    const summary = JSON.parse(
      (db.prepare('SELECT data FROM summaries LIMIT 1').get() as { data: string }).data
    ) as { topic: string; lastUserMessage: string };
    expect(session.first_prompt).toBe('why does the checkout page time out');
    expect(summary.topic).toBe('why does the checkout page time out');
    expect(summary.lastUserMessage).toBe('why does the checkout page time out');
  });

  it('fall back to the command when the session holds nothing else', () => {
    corpus.write(corpus.sessionPath('-work-shop', '7a12-topic'), [
      userLine('<command-name>/clear</command-name>', { cwd: '/work/shop' }),
      assistantText('Cleared.', { cwd: '/work/shop' }),
    ]);
    const db = corpus.open();

    sweep(db);

    const summary = JSON.parse(
      (db.prepare('SELECT data FROM summaries LIMIT 1').get() as { data: string }).data
    ) as { topic: string };
    expect(summary.topic).toContain('/clear');
  });
});

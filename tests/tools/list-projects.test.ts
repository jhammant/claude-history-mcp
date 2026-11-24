import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sweep } from '../../src/indexing/sweep.js';
import { handleListProjects } from '../../src/tools/list-projects.js';
import { assistantText, createCorpus, rolloutMessage, rolloutMeta, userLine, type Corpus } from '../helpers/corpus.js';

describe('list_projects', () => {
  let corpus: Corpus;

  beforeEach(() => {
    corpus = createCorpus();
    for (let i = 0; i < 35; i++) {
      const name = i === 7 ? 'billing' : `app${i}`;
      corpus.write(corpus.sessionPath(`-work-${name}`, `5e55-${i}`), [
        userLine(`question ${i}`, { cwd: `/work/${name}` }),
        assistantText(`answer ${i}`, { cwd: `/work/${name}` }),
      ]);
    }
    sweep(corpus.open());
  });
  afterEach(() => corpus.cleanup());

  it('caps the list by default and says how many are hidden', () => {
    // Act
    const text = handleListProjects(corpus.open(), {});

    // Assert
    expect(text).toContain('35 projects with conversation history, showing 30:');
    expect(text.match(/^- /gm)).toHaveLength(30);
    expect(text).toContain('5 more not shown');
  });

  it('honours limit', () => {
    const text = handleListProjects(corpus.open(), { limit: 3 });

    expect(text.match(/^- /gm)).toHaveLength(3);
    expect(text).toContain('32 more not shown');
  });

  it('filters by a part of the path', () => {
    const text = handleListProjects(corpus.open(), { query: 'Billing' });

    expect(text).toContain('1 project with conversation history matching "Billing":');
    expect(text).toContain('- /work/billing — 1 sessions, 2 messages');
    expect(text).not.toContain('more not shown');
  });

  it('says so when nothing matches the filter', () => {
    const text = handleListProjects(corpus.open(), { query: 'nope' });

    expect(text).toBe('No projects match "nope" (35 projects have history).');
  });

  it('leaves out sessions with no messages (Codex guardian-review threads): no unknown row, no count', () => {
    const u = '0199abcd-0000-7000-8000-000000000001';
    corpus.write(corpus.rolloutPath('2026-10-01', u), [
      rolloutMeta(u, { threadSource: 'guardian_review', parentThreadId: '0199abcd-0000-7000-8000-000000000000' }),
      rolloutMessage('user', 'review this action'),
    ]);
    corpus.write(corpus.sessionPath('-work-billing', 'empty-billing'), [userLine('', { cwd: '/work/billing', sessionId: 'empty-billing', isMeta: true })]);
    sweep(corpus.open());
    const db = corpus.open();
    expect(db.prepare("SELECT count(*) FROM sessions WHERE message_count = 0").pluck().get()).toBeGreaterThanOrEqual(1);

    const text = handleListProjects(db, { limit: 200 });
    expect(text).toContain('35 projects with conversation history:');
    expect(text).not.toMatch(/unknown/i);
    expect(handleListProjects(db, { query: 'billing' })).toContain('- /work/billing — 1 sessions, 2 messages');
  });
});

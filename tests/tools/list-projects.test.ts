import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sweep } from '../../src/indexing/sweep.js';
import { handleListProjects } from '../../src/tools/list-projects.js';
import { assistantText, createCorpus, userLine, type Corpus } from '../helpers/corpus.js';

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
});

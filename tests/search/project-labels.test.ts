import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { homedir } from 'os';
import { join } from 'path';
import { sweep } from '../../src/indexing/sweep.js';
import { formatSearchResponse, projectName, tildePath } from '../../src/search/format.js';
import { SearchEngine } from '../../src/search/search-engine.js';
import { readSession } from '../../src/sessions/read-session.js';
import { handleGetSessionSummary } from '../../src/tools/get-session-summary.js';
import { createCorpus, userLine, type Corpus } from '../helpers/corpus.js';

describe('project labels', () => {
  it('shows the working directory with the home directory as ~', () => {
    const home = homedir();
    expect(tildePath(join(home, 'dev', 'acme', 'shop', 'api'))).toBe('~/dev/acme/shop/api');
    expect(tildePath(home)).toBe('~');
    expect(tildePath(home + '-other/x')).toBe(home + '-other/x');
    expect(tildePath('/srv/app')).toBe('/srv/app');
  });

  it('falls back to the name from the encoded project dir when the working directory is unknown', () => {
    expect(projectName('-work-legacy-api', null)).toBe('api');
  });

  describe('in results', () => {
    let corpus: Corpus;
    const cwd = join(homedir(), 'dev', 'acme', 'shop', 'api');
    beforeEach(() => {
      corpus = createCorpus();
      corpus.write(corpus.sessionPath('-encoded-api', 'label-1'), [userLine('the ocelot endpoint', { cwd })]);
      sweep(corpus.open());
    });
    afterEach(() => corpus.cleanup());

    it('labels search hits, read_session and session summaries with the ~ path', () => {
      const db = corpus.open();
      expect(formatSearchResponse(new SearchEngine(db).search('ocelot'), 'ocelot'))
        .toContain('1. ~/dev/acme/shop/api · ');
      expect(readSession(db, { session_id: 'label-1' })).toMatch(/^Session label-1 · ~\/dev\/acme\/shop\/api · branch main\n/);
      const summary = handleGetSessionSummary(db, { session_id: 'label-1' });
      expect(summary).toContain('## Session Summary: ~/dev/acme/shop/api');
      expect(summary).toContain('**Project**: ~/dev/acme/shop/api');
    });
  });
});

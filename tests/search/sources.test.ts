import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCommand } from '../../src/cli/commands.js';
import { SOURCES } from '../../src/formats/types.js';
import { sweep } from '../../src/indexing/sweep.js';
import { formatSearchResponse } from '../../src/search/format.js';
import { parseQuery } from '../../src/search/query-processor.js';
import { SearchEngine } from '../../src/search/search-engine.js';
import { handleListProjects } from '../../src/tools/list-projects.js';
import {
  assistantText, codexLine, createCorpus, piAssistant, piSession, piText, piUser, userLine, type Corpus,
} from '../helpers/corpus.js';

const PI_UUID = '0a1b2c3d-0000-4000-8000-000000000001';

describe('three sources', () => {
  let corpus: Corpus;

  beforeEach(() => {
    corpus = createCorpus();
    corpus.write(corpus.sessionPath('-work-app', 'claude-1'), [
      userLine('gizmo question for claude', { cwd: '/work/app' }), assistantText('gizmo answer', { cwd: '/work/app' }),
    ]);
    corpus.write(corpus.codexPath('-work-app', 'codex-1'), [
      codexLine('user', 'gizmo question for codex', { sessionId: 'codex-1', cwd: '/work/app' }),
    ]);
    corpus.write(corpus.piPath('--work-app--', PI_UUID), [
      piSession(PI_UUID, { cwd: '/work/app' }), piUser('gizmo question for pi'), piAssistant([piText('gizmo reply')]),
    ]);
    // A Codex guardian-review style thread: indexed as a session with no messages.
    corpus.write(corpus.codexPath('-work-app', 'codex-empty'), [
      codexLine('user', '', { sessionId: 'codex-empty', cwd: '/work/app' }),
    ]);
    sweep(corpus.open());
  });
  afterEach(() => { vi.restoreAllMocks(); corpus.cleanup(); });

  it('lists the valid sources in one constant', () => {
    expect(SOURCES).toEqual(['claude', 'codex', 'pi']);
  });

  it('accepts source:pi and keeps an unknown source as search text', () => {
    expect(parseQuery('gizmo source:pi').filters.source).toBe('pi');
    const bad = parseQuery('gizmo source:gemini');
    expect(bad.filters).toEqual({});
    expect(bad.groups.map((g) => g[0].parts)).toContainEqual(['source', 'gemini']);
  });

  it('filters to pi sessions and tags a pi result', () => {
    const engine = new SearchEngine(corpus.open());
    const response = engine.search('gizmo source:pi');
    expect(response.hits.map((h) => h.sessionId)).toEqual([`pi-${PI_UUID}`]);
    expect(formatSearchResponse(response, 'gizmo source:pi')).toContain(' · pi');
    expect(engine.search('gizmo source:claude').hits.map((h) => h.sessionId)).toEqual(['claude-1']);
  });

  it('list_projects gives per-source counts and leaves out zero and empty ones', () => {
    const text = handleListProjects(corpus.open(), {});
    expect(text).toContain('1 Claude');
    expect(text).toContain('1 Codex');
    expect(text).toContain('1 pi');
    expect(text).not.toContain('2 Codex');
  });

  it('list_projects does not count subagent sessions in the per-source breakdown', () => {
    corpus.write(corpus.subagentPath('-work-app', 'claude-1', 'a1'), [userLine('sub gizmo', { cwd: '/work/app', isSidechain: true })]);
    sweep(corpus.open());
    const text = handleListProjects(corpus.open(), {});
    expect(text).toContain('1 Claude, 1 Codex, 1 pi');
  });

  it('status shows a count per source', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await runCommand('status', [])).toBe(0);
    const out = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toMatch(/1 Claude, 1 Codex, 1 pi/);
  });

  it('status --json carries sessionsBySource, a matching total and the old codexSessions', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await runCommand('status', ['--json'])).toBe(0);
    const status = JSON.parse(log.mock.calls[0][0] as string);
    expect(status.sessionsBySource).toEqual([
      { source: 'claude', sessions: 1 }, { source: 'codex', sessions: 1 }, { source: 'pi', sessions: 1 },
    ]);
    // The headline total is the sum of the breakdown; codexSessions keeps its old meaning (every Codex session, empty ones too).
    expect(status.sessions).toBe(3);
    expect(status.codexSessions).toBe(2);
  });

  it('status counts a Claude session with no messages, and the total still equals the breakdown', async () => {
    corpus.write(corpus.sessionPath('-work-quiet', 'quiet-1'), [userLine('', { cwd: '/work/quiet', sessionId: 'quiet-1', isMeta: true })]);
    sweep(corpus.open());
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await runCommand('status', ['--json'])).toBe(0);
    const status = JSON.parse(log.mock.calls[0][0] as string);
    expect(status.sessionsBySource).toEqual([
      { source: 'claude', sessions: 2 }, { source: 'codex', sessions: 1 }, { source: 'pi', sessions: 1 },
    ]);
    expect(status.sessions).toBe(4);
  });
});

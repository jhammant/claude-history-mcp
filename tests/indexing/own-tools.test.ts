import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { indexFile } from '../../src/indexing/indexer.js';
import { sweep } from '../../src/indexing/sweep.js';
import { isOwnTool } from '../../src/parsers/content-extractor.js';
import { SearchEngine } from '../../src/search/search-engine.js';
import { assistantText, codexLine, createCorpus, toolResult, toolUse, userLine, type Corpus } from '../helpers/corpus.js';

describe('isOwnTool', () => {
  it('recognises this server under the names Claude Code and Codex give MCP tools', () => {
    for (const name of [
      'mcp__claude-history__search_history', 'mcp__claude_history__find_solutions', 'claude-history__read_session',
      'mcp__claude-history-mcp__list_projects', 'mcp__ClaudeHistory__get_project_context', 'mcp__history__search_history',
      'mcp__plugin_tools_claude-history__find_patterns',
    ]) expect(isOwnTool(name), name).toBe(true);
  });

  it('leaves other tools alone', () => {
    for (const name of ['Bash', 'search_history', 'mcp__github__search_history', 'mcp__claude-history-cloud__sync',
      'mcp__weave__find_solutions', 'mcp__claude-in-chrome__navigate']) expect(isOwnTool(name), name).toBe(false);
  });
});

describe("not indexing this server's own echo", () => {
  let corpus: Corpus;
  const stored = (sessionId: string) => corpus.open().prepare(
    `SELECT m.role, m.tools, t.prose, t.tool_input, t.tool_output FROM messages m JOIN message_text t ON t.id = m.id
     JOIN sessions s ON s.sid = m.session_sid WHERE s.id = ? ORDER BY m.seq`,
  ).all(sessionId) as Array<{ role: string; tools: string; prose: string; tool_input: string; tool_output: string }>;
  const sessionsFor = (query: string) => new SearchEngine(corpus.open()).search(query).hits.map((h) => h.sessionId);

  beforeEach(() => { corpus = createCorpus(); });
  afterEach(() => corpus.cleanup());

  it('keeps the tool name but drops the input and the result of a search_history call', () => {
    // Arrange: another session holds the text the search returns
    corpus.write(corpus.sessionPath('-work-other', 'other'), [userLine('the quokka migration plan')]);
    corpus.write(corpus.sessionPath('-work-app', 'caller'), [
      userLine('what did we decide before?'),
      toolUse('mcp__claude-history__search_history', { query: 'quokka zanzibar' }, { id: 'a1', toolUseId: 'own1' }),
      toolResult('1 session for "quokka zanzibar": the quokka migration plan', { toolUseId: 'own1' }),
      toolUse('Bash', { command: 'ls zanzibar-dir' }, { id: 'a2', toolUseId: 'bash1' }),
      toolResult('zanzibar.txt', { toolUseId: 'bash1' }),
      assistantText('Found it.', { id: 'a3' }),
    ]);

    // Act
    sweep(corpus.open());

    // Assert
    const rows = stored('caller');
    expect(rows[1].tools).toBe('mcp__claude-history__search_history');
    expect(rows[1].tool_input + rows[1].tool_output).toBe('');
    expect(rows[2].tool_input).toBe('Bash: ls zanzibar-dir');
    expect(rows[2].tool_output).toBe('zanzibar.txt');
    expect(sessionsFor('quokka')).toEqual(['other']);
    expect(sessionsFor('zanzibar')).toEqual(['caller']);
    expect(new SearchEngine(corpus.open()).search('tool:search_history').hits.map((h) => h.sessionId)).toEqual(['caller']);
  });

  it('drops the result when it arrives in a later append than the call', () => {
    // Arrange: the server indexes the transcript while its own call is still running
    const path = corpus.write(corpus.sessionPath('-work-app', 'live'), [
      userLine('look it up'),
      toolUse('mcp__claude_history__find_solutions', { error_or_problem: 'ECONNRESET wombat' }, { id: 'a1', toolUseId: 'own2' }),
    ]);
    indexFile(corpus.open(), corpus.file(path));
    corpus.append(path, [toolResult([{ type: 'text', text: 'past fix: restart the wombat proxy' }], { toolUseId: 'own2' })]);

    // Act
    indexFile(corpus.open(), corpus.file(path));

    // Assert
    expect(stored('live')[1]).toMatchObject({ tools: 'mcp__claude_history__find_solutions', tool_input: '', tool_output: '' });
    expect(sessionsFor('wombat')).toEqual([]);
  });

  it('keeps Codex calls and results paired when a result is empty', () => {
    // Arrange: an empty result block used to drop out of the pairing, so the next own
    // result was matched to the wrong call and indexed
    const opts = { sessionId: 'codex-10', cwd: '/work/codex-api' };
    const call = (name: string, input: string) => codexLine('assistant', `[external_agent_tool_call: ${name}]\ninput: ${input}\n[/external_agent_tool_call]`, opts);
    const result = (text: string) => codexLine('assistant', `[external_agent_tool_result]${text}[/external_agent_tool_result]`, opts);
    corpus.write(corpus.codexPath('-work-codex-api', 'codex-10'), [
      call('Bash', '{"command":"true"}'), result(''),
      call('Read', '{"file_path":"notes.md"}'), result('\nnotes about the axolotl\n'),
      call('mcp__claude-history__get_session_summary', '{"session_id":"x"}'), result('\n## Session Summary: the capybara project\n'),
    ]);

    // Act
    sweep(corpus.open());

    // Assert
    expect(sessionsFor('axolotl')).toEqual(['codex-10']);
    expect(sessionsFor('capybara')).toEqual([]);
    expect(stored('codex-10').map((r) => [r.tools, r.tool_output])).toEqual([
      ['Bash', ''], ['Read', 'notes about the axolotl'], ['mcp__claude-history__get_session_summary', ''],
    ]);
  });

  it('handles Codex feed calls and results, which are tagged blocks in the message text', () => {
    // Arrange
    const opts = { sessionId: 'codex-9', cwd: '/work/codex-api' };
    corpus.write(corpus.codexPath('-work-codex-api', 'codex-9'), [
      codexLine('user', 'find the earlier notes', opts),
      codexLine('assistant', '[external_agent_tool_call: mcp__claude-history__search_history]\ninput: {"query":"platypus"}\n[/external_agent_tool_call]', opts),
      codexLine('assistant', '[external_agent_tool_result]\n1 session for "platypus": the platypus rollout\n[/external_agent_tool_result]', opts),
      codexLine('assistant', '[external_agent_tool_call: Bash]\ninput: {"command":"cat narwhal.log"}\n[/external_agent_tool_call]', opts),
      codexLine('assistant', '[external_agent_tool_result]\nnarwhal started\n[/external_agent_tool_result]', opts),
    ]);

    // Act
    sweep(corpus.open());

    // Assert
    const rows = stored('codex-9');
    expect(rows.map((r) => r.tools)).toEqual(['', 'mcp__claude-history__search_history', 'Bash']);
    expect(rows[1]).toMatchObject({ prose: '', tool_input: '', tool_output: '' });
    expect(rows[2]).toMatchObject({ prose: '', tool_input: 'Bash: cat narwhal.log', tool_output: 'narwhal started' });
    expect(sessionsFor('platypus')).toEqual([]);
    expect(sessionsFor('narwhal')).toEqual(['codex-9']);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { piFormat } from '../../src/formats/pi.js';
import { FORMATS } from '../../src/formats/registry.js';
import { indexFile } from '../../src/indexing/indexer.js';
import { UNKNOWN_PROJECT } from '../../src/utils/path-encoder.js';
import {
  createCorpus, piAssistant, piBashExecution, piMessage, piOther, piSession, piText, piThinking, piToolCall, piToolResult, piUser, type Corpus,
} from '../helpers/corpus.js';

const U1 = '0199bbbb-0000-7000-8000-000000000001';
const U2 = '0199bbbb-0000-7000-8000-000000000002';
const DIR = '--work-app--';

describe('pi format', () => {
  let corpus: Corpus;
  beforeEach(() => { corpus = createCorpus(); });
  afterEach(() => { vi.restoreAllMocks(); corpus.cleanup(); });

  const session = (id: string) =>
    corpus.open().prepare('SELECT project, source, is_subagent, message_count, cwd, first_prompt FROM sessions WHERE id = ?').get(id) as
      { project: string; source: string; is_subagent: number; message_count: number; cwd: string | null; first_prompt: string | null } | undefined;
  const messages = (id: string) =>
    corpus.open().prepare(
      `SELECT m.role, m.tools, t.prose, t.tool_input, t.tool_output FROM messages m JOIN message_text t ON t.id = m.id
       JOIN sessions s ON s.sid = m.session_sid WHERE s.id = ? ORDER BY m.seq`
    ).all(id) as Array<{ role: string; tools: string; prose: string; tool_input: string; tool_output: string }>;
  const index = (path: string) => indexFile(corpus.open(), corpus.file(path));
  const translate = (path: string, lines: Array<Record<string, unknown>>, resumed = false) => {
    const tr = piFormat.translator(corpus.file(path), resumed);
    return lines.flatMap((l) => tr.translate(l));
  };

  it('is registered last and lists session files with pi-<uuid> ids', () => {
    expect(FORMATS.map((f) => f.id)).toEqual(['claude', 'codex-feed', 'codex-rollout', 'pi']);
    const path = corpus.write(corpus.piPath(DIR, U1), [piSession(U1)]);
    corpus.write(`${corpus.piSessions}/${DIR}/notes.txt`, [{}]);
    const found = piFormat.list(piFormat.root(), {});
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ path, source: 'pi', format: 'pi', sessionId: `pi-${U1}`, projectDir: UNKNOWN_PROJECT, isSubagent: false });
    expect(piFormat.projectFromContent).toBe(true);
  });

  it('indexes user and assistant text, drops thinking, system and custom messages, project from cwd', () => {
    const path = corpus.write(corpus.piPath(DIR, U1), [
      piSession(U1, { cwd: '/work/app' }),
      piOther('model_change', { provider: 'x', modelId: 'y' }),
      piMessage('system', 'system prompt never indexed'),
      piOther('custom_message', { customType: 'x', content: 'custom text never indexed', display: true }),
      piUser('please add the widget'),
      piAssistant([piThinking('private reasoning'), piText('adding the widget now')]),
      piAssistant([piThinking('only thinking')]),
      piOther('compaction', { summary: 'summary text' }),
    ]);
    index(path);
    expect(session(`pi-${U1}`)).toMatchObject({
      project: '-work-app', source: 'pi', is_subagent: 0, message_count: 2, cwd: '/work/app', first_prompt: 'please add the widget',
    });
    const stored = messages(`pi-${U1}`);
    expect(stored.map((m) => [m.role, m.prose])).toEqual([['user', 'please add the widget'], ['assistant', 'adding the widget now']]);
    expect(JSON.stringify(stored)).not.toContain('private reasoning');
  });

  it('pairs a toolCall with its toolResult by id and keeps non-shell tools under their name', () => {
    const path = corpus.write(corpus.piPath(DIR, U1), [
      piSession(U1), piUser('read it'),
      piAssistant([piText('reading'), piToolCall('c1', 'read', { path: '/work/app/a.ts' })]),
      piToolResult('c1', 'read', 'file body here'),
    ]);
    index(path);
    const stored = messages(`pi-${U1}`);
    expect(stored).toHaveLength(2);
    expect(stored[1].tools).toBe('read');
    expect(stored[1].tool_input).toContain('/work/app/a.ts');
    expect(stored[1].tool_output).toContain('file body here');
  });

  it('reads the bash tool as a shell call', () => {
    const path = corpus.write(corpus.piPath(DIR, U1), [
      piSession(U1), piUser('close it'),
      piAssistant([piToolCall('c1', 'bash', { command: 'echo marker-1 --reason done', timeout: 30 })]),
      piToolResult('c1', 'bash', 'marker-1 printed\n'),
    ]);
    index(path);
    const stored = messages(`pi-${U1}`);
    expect(stored[1].tools).toBe('Bash');
    expect(stored[1].tool_input).toContain('echo marker-1 --reason done');
    expect(stored[1].tool_output).toContain('marker-1 printed');
  });

  it('turns a bashExecution message into a Bash call and its result', () => {
    const path = corpus.write(corpus.piPath(DIR, U1), [
      piSession(U1), piUser('go'),
      piBashExecution('echo marker-2', 'marker-2 printed\n'),
    ]);
    const out = translate(path, [piBashExecution('false', 'nope', { exitCode: 1 }), piBashExecution('sleep 9', '', { cancelled: true })]);
    const [call, result] = out.map((l) => (l.message as { content: Array<Record<string, unknown>> }).content[0]);
    expect(call).toMatchObject({ type: 'tool_use', name: 'Bash', input: { command: 'false' } });
    expect(result).toMatchObject({ type: 'tool_result', tool_use_id: call.id, content: 'nope', is_error: true });
    expect((out[3].message as { content: Array<Record<string, unknown>> }).content[0]).toMatchObject({ is_error: true });
    index(path);
    const stored = messages(`pi-${U1}`);
    expect(stored[1].tools).toBe('Bash');
    expect(stored[1].tool_input).toContain('echo marker-2');
    expect(stored[1].tool_output).toContain('marker-2 printed');
  });

  it('marks a failed toolResult as an error and gives each line the cwd', () => {
    const path = corpus.write(corpus.piPath(DIR, U1), [piSession(U1, { cwd: '/work/app' })]);
    const out = translate(path, [
      piSession(U1, { cwd: '/work/app' }),
      piAssistant([piToolCall('c1', 'bash', { command: 'ls' })]),
      piToolResult('c1', 'bash', 'boom', { isError: true }),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ type: 'assistant', cwd: '/work/app' });
    expect(out[1]).toMatchObject({ type: 'user', cwd: '/work/app' });
    expect((out[1].message as { content: object[] }).content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'c1', content: 'boom', is_error: true });
  });

  it('seeds cwd from the first line on a resumed read only', () => {
    const path = corpus.write(corpus.piPath(DIR, U1), [piSession(U1, { cwd: '/work/app' })]);
    expect(translate(path, [piUser('late')], true)[0]).toMatchObject({ cwd: '/work/app' });
    expect(translate(path, [piUser('late')], false)[0]).not.toHaveProperty('cwd');
  });

  it('keeps the stored project when a resumed read finds no cwd', () => {
    // First line is not a session record, so a resumed read cannot recover the cwd; the session line comes later.
    const path = corpus.write(corpus.piPath(DIR, U1), [piOther('model_change'), piSession(U1, { cwd: '/work/app' }), piUser('first')]);
    index(path);
    expect(session(`pi-${U1}`)).toMatchObject({ project: '-work-app', message_count: 1 });
    expect(translate(path, [piUser('second')], true)[0]).not.toHaveProperty('cwd');
    corpus.append(path, [piUser('second')]);
    index(path);
    expect(session(`pi-${U1}`)).toMatchObject({ project: '-work-app', cwd: '/work/app', message_count: 2 });
    expect(messages(`pi-${U1}`).map((m) => m.prose)).toEqual(['first', 'second']);
  });

  it('indexes a file with no session line under the unknown project', () => {
    const path = corpus.write(corpus.piPath(DIR, U2), [piOther('model_change'), piUser('x')]);
    index(path);
    expect(session(`pi-${U2}`)).toMatchObject({ project: UNKNOWN_PROJECT, message_count: 1 });
  });

  it('handles a toolResult with empty content or a non-text block', () => {
    const path = corpus.write(corpus.piPath(DIR, U1), [piSession(U1)]);
    const empty = piToolResult('c1', 'read', '');
    (empty.message as { content: unknown }).content = [];
    const image = piToolResult('c2', 'read', '');
    (image.message as { content: unknown }).content = [{ type: 'image', data: 'x', mimeType: 'image/png' }, { type: 'text', text: 'kept' }];
    const out = translate(path, [empty, image]);
    const blocks = out.map((l) => (l.message as { content: Array<Record<string, unknown>> }).content[0]);
    expect(blocks[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'c1', content: '', is_error: false });
    expect(blocks[1]).toMatchObject({ tool_use_id: 'c2', content: 'kept' });
  });

  it('gives fallback ids a per-read token so reads cannot collide', () => {
    const path = corpus.write(corpus.piPath(DIR, U1), [piSession(U1)]);
    const line = () => ({ type: 'message', timestamp: '2026-10-01T09:00:00Z', message: { role: 'assistant', content: [piText('a')] } });
    const a = translate(path, [line()])[0].message as { id: string };
    const b = translate(path, [line()])[0].message as { id: string };
    expect(a.id).not.toBe(b.id);
  });

  it('takes the session id from a file name with no underscore', () => {
    const path = corpus.write(`${corpus.piSessions}/${DIR}/plain.jsonl`, [piSession(U1)]);
    expect(piFormat.list(piFormat.root(), {}).find((f) => f.path === path)?.sessionId).toBe('pi-plain');
  });

  it('skips a malformed line', () => {
    const path = corpus.write(corpus.piPath(DIR, U1), [piSession(U1), piUser('before')]);
    corpus.appendRaw(path, '{"type":"message", oops\n');
    corpus.append(path, [piAssistant([piText('after')])]);
    index(path);
    expect(messages(`pi-${U1}`).map((m) => m.prose)).toEqual(['before', 'after']);
  });

  it('isMessageLine accepts message lines only', () => {
    expect(piFormat.isMessageLine('{"type":"message","id":"a"')).toBe(true);
    expect(piFormat.isMessageLine('{"type":"compaction","id":"a"')).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { codexRolloutFormat, INJECTED_USER_PREFIXES } from '../../src/formats/codex-rollout.js';
import { scanCell, UNCERTAIN_ON_SHORT_CIRCUIT_AND_TERNARY } from '../../src/formats/js-cell.js';
import { FORMATS } from '../../src/formats/registry.js';
import { indexFile, parsePendingTools, RowBuilder } from '../../src/indexing/indexer.js';
import { UNKNOWN_PROJECT } from '../../src/utils/path-encoder.js';
import {
  createCorpus, rolloutCall, rolloutEvent, rolloutMessage, rolloutMeta, rolloutOutput, rolloutTurn, type Corpus,
} from '../helpers/corpus.js';

const U1 = '0199aaaa-0000-7000-8000-000000000001';
const U2 = '0199aaaa-0000-7000-8000-000000000002';
const DATE = '2026-10-01';

describe('codex rollout format', () => {
  let corpus: Corpus;
  beforeEach(() => { corpus = createCorpus(); });
  afterEach(() => { vi.restoreAllMocks(); corpus.cleanup(); });

  const session = (id: string) =>
    corpus.open().prepare('SELECT sid, project, source, is_subagent, message_count, cwd, git_branch, first_prompt FROM sessions WHERE id = ?').get(id) as
      { sid: number; project: string; source: string; is_subagent: number; message_count: number; cwd: string | null; git_branch: string | null; first_prompt: string | null } | undefined;
  const messages = (id: string) =>
    corpus.open().prepare(
      `SELECT m.role, m.tools, t.prose, t.tool_input, t.tool_output FROM messages m JOIN message_text t ON t.id = m.id
       JOIN sessions s ON s.sid = m.session_sid WHERE s.id = ? ORDER BY m.seq`
    ).all(id) as Array<{ role: string; tools: string; prose: string; tool_input: string; tool_output: string }>;
  const index = (path: string) => indexFile(corpus.open(), corpus.file(path));
  const translate = (path: string, lines: Array<Record<string, unknown>>, resumed = false) => {
    const tr = codexRolloutFormat.translator(corpus.file(path), resumed);
    return lines.flatMap((l) => tr.translate(l));
  };

  it('is registered after the feed and lists rollout files by date', () => {
    expect(FORMATS.map((f) => f.id)).toEqual(['claude', 'codex-feed', 'codex-rollout', 'pi']);
    const path = corpus.write(corpus.rolloutPath(DATE, U1), [rolloutMeta(U1)]);
    corpus.write(`${corpus.codexSessions}/2026/10/01/notes.jsonl`, [{}]);
    corpus.write(`${corpus.codexSessions}/stray/rollout-x-${U2}.jsonl`, [{}]);
    const found = codexRolloutFormat.list(codexRolloutFormat.root(), {});
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      path, source: 'codex', format: 'codex-rollout', sessionId: `codex-${U1}`, projectDir: UNKNOWN_PROJECT, isSubagent: false,
    });
    expect(codexRolloutFormat.projectFromContent).toBe(true);
  });

  for (const generation of ['without', 'with'] as const) {
    it(`indexes user and assistant text as two messages, project from cwd (${generation} ordinal)`, () => {
      const o = (n: number) => (generation === 'with' ? { ordinal: n } : {});
      const path = corpus.write(corpus.rolloutPath(DATE, U1), [
        rolloutMeta(U1, { ...o(0), cwd: '/work/app' }),
        rolloutMessage('developer', 'developer instructions never indexed', o(1)),
        rolloutMessage('user', 'please add the widget', o(2)),
        rolloutEvent('user_message', { message: 'please add the widget' }, o(3)),
        rolloutMessage('assistant', 'adding the widget now', o(4)),
        rolloutEvent('agent_message', { message: 'adding the widget now' }, o(5)),
        rolloutEvent('token_count', {}, o(6)),
        { timestamp: '2026-10-01T09:05:00Z', type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'x' } },
        { timestamp: '2026-10-01T09:05:00Z', type: 'response_item', payload: { type: 'agent_message', message: 'inter-agent traffic' } },
      ]);
      index(path);
      expect(session(`codex-${U1}`)).toMatchObject({
        project: '-work-app', source: 'codex', is_subagent: 0, message_count: 2, cwd: '/work/app', git_branch: 'main', first_prompt: 'please add the widget',
      });
      expect(messages(`codex-${U1}`).map((m) => [m.role, m.prose])).toEqual([
        ['user', 'please add the widget'], ['assistant', 'adding the widget now'],
      ]);
    });
  }

  it.each(INJECTED_USER_PREFIXES)('drops a user message starting with %s', (prefix) => {
    const path = corpus.write(corpus.rolloutPath(DATE, U1), [
      rolloutMeta(U1),
      rolloutMessage('user', `${prefix} wrapper body that is not the user's words`),
      rolloutMessage('user', 'the real question'),
    ]);
    index(path);
    expect(messages(`codex-${U1}`).map((m) => m.prose)).toEqual(['the real question']);
  });

  it('keeps the exported prefixes the survey found', () => {
    expect(INJECTED_USER_PREFIXES).toEqual(expect.arrayContaining([
      '<environment_context>', '<user_instructions>', '<turn_aborted>', '# AGENTS.md instructions',
      '<recommended_plugins>', '<subagent_notification>', '<user_action>', '<no retained transcript delta entries>',
    ]));
  });

  it('drops only the injected block of a user message that also has real text', () => {
    const line = rolloutMessage('user', '<environment_context>\n  <cwd>/x</cwd>\n</environment_context>');
    (line.payload as { content: object[] }).content.push({ type: 'input_text', text: 'and my words' });
    const path = corpus.write(corpus.rolloutPath(DATE, U1), [rolloutMeta(U1), line]);
    index(path);
    expect(messages(`codex-${U1}`).map((m) => m.prose)).toEqual(['and my words']);
  });

  describe('tool calls', () => {
    it('pairs an exec_command call with its output', () => {
      const path = corpus.write(corpus.rolloutPath(DATE, U1), [
        rolloutMeta(U1),
        rolloutMessage('user', 'close it'),
        rolloutCall('exec_command', { cmd: 'echo marker-1 --reason done', workdir: '/work/app' }, 'call-1'),
        rolloutOutput('call-1', 'Chunk ID: ab12\nWall time: 0.1 seconds\nProcess exited with code 0\nOriginal token count: 9\nOutput:\nmarker-1 printed\n'),
      ]);
      index(path);
      const stored = messages(`codex-${U1}`);
      expect(stored).toHaveLength(2);
      expect(stored[1].tools).toBe('Bash');
      expect(stored[1].tool_input).toContain('echo marker-1');
      expect(stored[1].tool_output).toContain('marker-1 printed');
    });

    it('still pairs when the output arrives in a later indexing run', () => {
      const path = corpus.write(corpus.rolloutPath(DATE, U1), [
        rolloutMeta(U1), rolloutMessage('user', 'close it'),
        rolloutCall('shell_command', { command: 'echo marker-1', workdir: '/work/app' }, 'call-1'),
      ]);
      index(path);
      expect(messages(`codex-${U1}`)[1].tool_output).toBe('');
      corpus.append(path, [rolloutOutput('call-1', 'Exit code: 0\nWall time: 0.2 seconds\nOutput:\nmarker-1 printed\n')]);
      index(path);
      expect(messages(`codex-${U1}`)[1].tool_output).toContain('marker-1 printed');
    });

    it('does not read an exec code cell as a shell command', () => {
      const cell = 'const note = `\necho marker-1\n`;\ntext(note)';
      const path = corpus.write(corpus.rolloutPath(DATE, U1), [
        rolloutMeta(U1), rolloutMessage('user', 'run it'),
        rolloutCall('exec', cell, 'call-x', { custom: true }),
        rolloutOutput('call-x', [{ type: 'input_text', text: 'Script completed\nWall time: 1 seconds' }, { type: 'input_text', text: 'echo marker-1' }], { custom: true }),
      ]);
      index(path);
      expect(messages(`codex-${U1}`)[1].tools).toBe('exec');
      expect(messages(`codex-${U1}`)[1].tool_input).toContain('echo marker-1');
    });

    it('keeps apply_patch under its own name, input a string', () => {
      const path = corpus.write(corpus.rolloutPath(DATE, U1), [
        rolloutMeta(U1), rolloutMessage('user', 'patch it'),
        rolloutCall('apply_patch', '*** Begin Patch\n*** Update File: a.ts\n*** End Patch', 'call-p', { custom: true }),
        rolloutOutput('call-p', JSON.stringify({ output: 'Success', metadata: { exit_code: 0, duration_seconds: 0.1 } }), { custom: true }),
      ]);
      index(path);
      const stored = messages(`codex-${U1}`);
      expect(stored[1].tools).toBe('apply_patch');
      expect(stored[1].tool_input).toContain('Update File: a.ts');
    });

    it('emits Bash with a command for each shell tool and unwraps an argv', () => {
      const path = corpus.write(corpus.rolloutPath(DATE, U1), [rolloutMeta(U1)]);
      const out = translate(path, [
        rolloutCall('exec_command', { cmd: 'ls -la' }, 'a'),
        rolloutCall('shell_command', { command: 'pwd' }, 'b'),
        rolloutCall('shell', { command: ['bash', '-lc', 'git status'] }, 'c'),
        rolloutCall('shell', { command: ['git', 'log', '--oneline'] }, 'd'),
        rolloutCall('exec', 'const c = "ls -la"; text(await tools.exec_command({cmd: c}))', 'e', { custom: true }),
        rolloutCall('write_stdin', { session_id: 1, chars: '' }, 'f'),
      ]);
      const uses = out.map((l) => (l.message as { content: Array<{ name: string; id: string; input: unknown }> }).content[0]);
      expect(uses.map((u) => [u.id, u.name])).toEqual([
        ['a', 'Bash'], ['b', 'Bash'], ['c', 'Bash'], ['d', 'Bash'], ['e', 'exec'], ['f', 'write_stdin'],
      ]);
      expect(uses.slice(0, 4).map((u) => (u.input as { command: string }).command)).toEqual(['ls -la', 'pwd', 'git status', 'git log --oneline']);
      expect(uses[4].input).toEqual({ input: 'const c = "ls -la"; text(await tools.exec_command({cmd: c}))' });
      expect(uses[5].input).toEqual({ session_id: 1, chars: '' });
    });

    it('marks an output as an error from the header shapes found in real files', () => {
      const path = corpus.write(corpus.rolloutPath(DATE, U1), [rolloutMeta(U1)]);
      const isError = (output: string | object[]) => {
        const [line] = translate(path, [rolloutOutput('x', output)]);
        const block = (line.message as { content: Array<{ is_error: boolean; tool_use_id: string }> }).content[0];
        expect(block.tool_use_id).toBe('x');
        return block.is_error;
      };
      expect(isError('Exit code: 1\nWall time: 0.1 seconds\nOutput:\nboom')).toBe(true);
      expect(isError('Exit code: 0\nWall time: 0.1 seconds\nOutput:\nfine')).toBe(false);
      expect(isError('Chunk ID: a\nWall time: 1 seconds\nProcess exited with code 2\nOriginal token count: 3\nOutput:\nboom')).toBe(true);
      expect(isError('Chunk ID: a\nWall time: 1 seconds\nProcess exited with code 0\nOutput:\nExit code: 7 in my text')).toBe(false);
      expect(isError('Chunk ID: a\nProcess running with session ID 5\nOutput:\n')).toBe(false);
      expect(isError(JSON.stringify({ output: 'x', metadata: { exit_code: 3, duration_seconds: 1 } }))).toBe(true);
      expect(isError(JSON.stringify({ output: 'x', metadata: { exit_code: 0 } }))).toBe(false);
      expect(isError([{ type: 'input_text', text: 'Script failed\nWall time: 1 seconds' }, { type: 'input_text', text: 'trace' }])).toBe(true);
      expect(isError([{ type: 'input_text', text: 'Script completed\nWall time: 1 seconds' }])).toBe(false);
      expect(isError('not json {"metadata":{"exit_code":1}}')).toBe(false);
    });

    it('reads array outputs as text, skipping images', () => {
      const path = corpus.write(corpus.rolloutPath(DATE, U1), [rolloutMeta(U1)]);
      const [line] = translate(path, [rolloutOutput('x', [
        { type: 'input_text', text: 'first' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }, { type: 'input_text', text: 'second' },
      ])]);
      const block = (line.message as { content: Array<{ content: string }> }).content[0];
      expect(block.content).toBe('first\nsecond');
    });
  });

  describe('session meta', () => {
    it('carries cwd and branch onto the lines that follow, and turn_context updates the cwd', () => {
      const path = corpus.write(corpus.rolloutPath(DATE, U1), [rolloutMeta(U1)]);
      const out = translate(path, [
        rolloutMeta(U1, { cwd: '/work/app', branch: 'feat/x' }),
        rolloutMessage('user', 'hello'),
        rolloutTurn('/work/other'),
        rolloutMessage('assistant', 'hi'),
      ]);
      expect(out).toHaveLength(2);
      expect(out[0]).toMatchObject({ type: 'user', cwd: '/work/app', gitBranch: 'feat/x' });
      // At another cwd the header's branch does not apply.
      expect(out[1]).toMatchObject({ type: 'assistant', cwd: '/work/other' });
      expect(out[1]).not.toHaveProperty('gitBranch');
      expect((out[1].message as { id: unknown }).id).toEqual(expect.any(String));
    });

    it('seeds cwd and branch from the first line on a resumed read, and turn_context still updates the cwd', () => {
      const path = corpus.write(corpus.rolloutPath(DATE, U1), [
        rolloutMeta(U1, { cwd: '/work/app', branch: 'feat/y' }),
      ]);
      const out = translate(path, [
        rolloutCall('exec_command', { cmd: 'ls' }, 'mid'), rolloutTurn('/work/later'), rolloutMessage('user', 'late'),
      ], true);
      expect(out[0]).toMatchObject({ cwd: '/work/app', gitBranch: 'feat/y' });
      expect(out[1]).toMatchObject({ cwd: '/work/later' });
      expect(out[1]).not.toHaveProperty('gitBranch');
    });

    it('groups an assistant text, its calls and the next result, and starts a new turn after a result', () => {
      const path = corpus.write(corpus.rolloutPath(DATE, U1), [rolloutMeta(U1)]);
      const out = translate(path, [
        rolloutMessage('assistant', 'looking'),
        rolloutCall('exec_command', { cmd: 'ls' }, 'a'),
        rolloutCall('exec_command', { cmd: 'pwd' }, 'b'),
        rolloutOutput('a', 'x'),
        rolloutOutput('b', 'y'),
        rolloutCall('exec_command', { cmd: 'date' }, 'c'),
      ]);
      const ids = out.map((l) => (l.message as { id?: string }).id);
      expect(ids[0]).toBe(ids[1]);
      expect(ids[1]).toBe(ids[2]);
      expect(ids[5]).not.toBe(ids[0]);
    });

    it('reaches the builder as SessionUpdate.branch, the first one seen', () => {
      const builder = new RowBuilder(null, 0, false, parsePendingTools(''));
      const path = corpus.write(corpus.rolloutPath(DATE, U1), [rolloutMeta(U1)]);
      for (const l of translate(path, [rolloutMeta(U1, { branch: 'feat/a' }), rolloutMessage('user', 'hi')])) builder.addLine(l);
      builder.addLine({ type: 'user', gitBranch: 'feat/b', message: { content: 'again' } });
      expect(builder.update.branch).toBe('feat/a');
    });

    it('indexes a sub-thread as an ordinary session', () => {
      const path = corpus.write(corpus.rolloutPath(DATE, U2), [
        rolloutMeta(U2, { threadSource: 'subagent', parentThreadId: U1 }), rolloutMessage('user', 'sub task'), rolloutMessage('assistant', 'done'),
      ]);
      index(path);
      expect(session(`codex-${U2}`)).toMatchObject({ is_subagent: 0, message_count: 2 });
    });

    it('indexes a guardian_review thread as a session with 0 messages, also when appended to later', () => {
      const path = corpus.write(corpus.rolloutPath(DATE, U2), [
        rolloutMeta(U2, { threadSource: 'guardian_review', parentThreadId: U1 }), rolloutMessage('user', 'review this action'), rolloutMessage('assistant', 'approved'),
      ]);
      index(path);
      expect(session(`codex-${U2}`)).toMatchObject({ message_count: 0, project: UNKNOWN_PROJECT });
      expect(messages(`codex-${U2}`)).toEqual([]);
      // A resumed read has not seen session_meta: it re-reads the file's first line.
      corpus.append(path, [rolloutTurn('/work/app'), rolloutMessage('user', 'another review')]);
      index(path);
      expect(session(`codex-${U2}`)).toMatchObject({ message_count: 0 });
    });
  });

  describe('robustness', () => {
    it('skips a malformed line in the middle', () => {
      const path = corpus.write(corpus.rolloutPath(DATE, U1), [rolloutMeta(U1), rolloutMessage('user', 'before')]);
      corpus.appendRaw(path, '{"timestamp": "2026-10-01T09:00:00Z", "type": "response_item", "payload": {oops\n');
      corpus.append(path, [rolloutMessage('assistant', 'after')]);
      index(path);
      expect(messages(`codex-${U1}`).map((m) => m.prose)).toEqual(['before', 'after']);
    });

    it('skips an oversized event_msg line without parsing it', () => {
      const big = '{"timestamp":"2026-10-01T09:00:00Z","type":"event_msg","payload":{"type":"exec_command_end","aggregated_output":"'
        + 'x'.repeat(1_200_000) + '"} this is not valid json after the first 2 KB\n';
      const path = corpus.write(corpus.rolloutPath(DATE, U1), [rolloutMeta(U1), rolloutMessage('user', 'before')]);
      corpus.appendRaw(path, big);
      corpus.append(path, [rolloutMessage('assistant', 'after')]);
      const parse = vi.spyOn(JSON, 'parse');
      index(path);
      expect(parse.mock.calls.some(([text]) => typeof text === 'string' && text.length > 1_000_000)).toBe(false);
      expect(messages(`codex-${U1}`).map((m) => m.prose)).toEqual(['before', 'after']);
      expect(codexRolloutFormat.isMessageLine(big.slice(0, 2048))).toBe(false);
    });

    it('still parses an oversized session_meta for its cwd and git branch', () => {
      const meta = rolloutMeta(U1, { cwd: '/work/app', branch: 'big-branch' });
      (meta.payload as Record<string, unknown>).base_instructions = { text: 'y'.repeat(1_200_000) };
      const path = corpus.write(corpus.rolloutPath(DATE, U1), [meta, rolloutMessage('user', 'hello')]);
      index(path);
      expect(session(`codex-${U1}`)).toMatchObject({ project: '-work-app', cwd: '/work/app', git_branch: 'big-branch', message_count: 1 });
      expect(codexRolloutFormat.isMessageLine(JSON.stringify(meta).slice(0, 2048))).toBe(true);
    });

    it('treats the three record families as messages and nothing else', () => {
      const head = (type: string) => `{"timestamp":"t","type":"${type}","payload":{}}`;
      expect(['response_item', 'turn_context', 'session_meta'].map((t) => codexRolloutFormat.isMessageLine(head(t)))).toEqual([true, true, true]);
      expect(['event_msg', 'compacted', 'world_state'].map((t) => codexRolloutFormat.isMessageLine(head(t)))).toEqual([false, false, false]);
    });

    it('skips a rollout whose session id the feed already indexed, with one log line', () => {
      const feedPath = corpus.write(corpus.codexPath('-work-app', `codex-${U1}`), [
        { type: 'user', cwd: '/work/app', timestamp: '2026-10-01T09:00:00Z', message: { role: 'user', content: 'from the feed' } },
      ]);
      index(feedPath);
      const rolloutFile = corpus.write(corpus.rolloutPath(DATE, U1), [rolloutMeta(U1), rolloutMessage('user', 'from the rollout')]);
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(index(rolloutFile).status).toBe('unchanged');
      index(rolloutFile); // a later sweep: no second line
      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0][0])).toContain(`codex-${U1}`);
      expect(messages(`codex-${U1}`).map((m) => m.prose)).toEqual(['from the feed']);
      expect(corpus.open().prepare('SELECT count(*) AS n FROM files').get()).toEqual({ n: 1 });
    });

    it('skips a feed file whose session id a rollout already indexed, with one log line', () => {
      const rolloutFile = corpus.write(corpus.rolloutPath(DATE, U1), [rolloutMeta(U1), rolloutMessage('user', 'from the rollout')]);
      index(rolloutFile);
      const feedPath = corpus.write(corpus.codexPath('-work-app', `codex-${U1}`), [
        { type: 'user', cwd: '/work/app', timestamp: '2026-10-01T09:00:00Z', message: { role: 'user', content: 'from the feed' } },
      ]);
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(index(feedPath).status).toBe('unchanged');
      corpus.append(feedPath, [{ type: 'assistant', timestamp: '2026-10-01T09:01:00Z', message: { role: 'assistant', content: 'feed reply' } }]);
      index(feedPath); // later runs: no second line
      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0][0])).toContain(`codex-${U1}`);
      expect(messages(`codex-${U1}`).map((m) => m.prose)).toEqual(['from the rollout']);
      expect(corpus.open().prepare('SELECT count(*) AS n FROM files').get()).toEqual({ n: 1 });
    });

    it('indexes a session present as both feed and rollout once, whichever is indexed first', () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const counts = ([['feed', 'rollout'], ['rollout', 'feed']] as const).map((order) => {
        const c = createCorpus();
        try {
          const paths = {
            feed: c.write(c.codexPath('-work-app', `codex-${U1}`), [
              { type: 'user', cwd: '/work/app', timestamp: '2026-10-01T09:00:00Z', message: { role: 'user', content: 'the question' } },
              { type: 'assistant', timestamp: '2026-10-01T09:00:05Z', message: { role: 'assistant', content: 'the answer' } },
            ]),
            rollout: c.write(c.rolloutPath(DATE, U1), [
              rolloutMeta(U1), rolloutMessage('user', 'the question'), rolloutMessage('assistant', 'the answer'),
            ]),
          };
          for (const kind of order) indexFile(c.open(), c.file(paths[kind]));
          return c.open().prepare('SELECT count(*) FROM messages').pluck().get();
        } finally {
          c.cleanup();
        }
      });
      expect(counts).toEqual([2, 2]);
    });

    it('skips a second rollout file with the same session id at another path, logging once', () => {
      const first = corpus.write(corpus.rolloutPath(DATE, U1), [rolloutMeta(U1), rolloutMessage('user', 'original')]);
      const second = corpus.write(corpus.rolloutPath('2026-10-02', U1), [rolloutMeta(U1), rolloutMessage('user', 'copy')]);
      index(first);
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      index(second);
      index(second);
      expect(error).toHaveBeenCalledTimes(1);
      expect(messages(`codex-${U1}`).map((m) => m.prose)).toEqual(['original']);
    });

    it('still indexes an oversized response_item that carries ordinal', () => {
      const path = corpus.write(corpus.rolloutPath(DATE, U1), [rolloutMeta(U1, { ordinal: 0 })]);
      corpus.append(path, [rolloutMessage('assistant', 'big answer ' + 'z '.repeat(150_000), { ordinal: 1 })]);
      index(path);
      expect(messages(`codex-${U1}`)).toHaveLength(1);
    });

    it('treats a first line over the read cap as an ordinary session', () => {
      const meta = rolloutMeta(U1, { cwd: '/work/app' });
      (meta.payload as Record<string, unknown>).base_instructions = { text: 'y'.repeat(4_300_000) };
      const path = corpus.write(corpus.rolloutPath(DATE, U1), [meta, rolloutMessage('user', 'hello')]);
      index(path);
      corpus.append(path, [rolloutMessage('assistant', 'more')]);
      index(path);
      expect(session(`codex-${U1}`)).toMatchObject({ message_count: 2, project: '-work-app' });
    });

    it('keeps indexing a rollout it already owns', () => {
      const path = corpus.write(corpus.rolloutPath(DATE, U1), [rolloutMeta(U1), rolloutMessage('user', 'one')]);
      index(path);
      corpus.append(path, [rolloutMessage('assistant', 'two')]);
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      index(path);
      expect(error).not.toHaveBeenCalled();
      expect(messages(`codex-${U1}`)).toHaveLength(2);
    });

    it('leaves the project unknown when the cwd is the filesystem root', () => {
      const path = corpus.write(corpus.rolloutPath(DATE, U1), [rolloutMeta(U1, { cwd: '/' }), rolloutMessage('user', 'at root')]);
      index(path);
      expect(session(`codex-${U1}`)).toMatchObject({ project: UNKNOWN_PROJECT, message_count: 1 });
    });
  });
});

describe('codex exec code cells', () => {
  let corpus: Corpus;
  beforeEach(() => { corpus = createCorpus(); });
  afterEach(() => corpus.cleanup());

  const cellOut = (text = 'Script completed\nWall time: 0.1 seconds') =>
    [{ type: 'input_text', text }, { type: 'input_text', text: 'Chunk ID: a\nProcess exited with code 0\nOutput:\nmarker-1 printed\n' }];
  const path = (lines: object[]) => corpus.write(corpus.rolloutPath(DATE, U1), [rolloutMeta(U1, { cwd: '/work/app' }), ...lines]);
  const uses = (cell: string, callId = 'cell') => {
    const file = corpus.file(path([]));
    const tr = codexRolloutFormat.translator(file, false);
    tr.translate(rolloutMeta(U1, { cwd: '/work/app', branch: 'feat/z' }) as Record<string, unknown>);
    return tr.translate(rolloutCall('exec', cell, callId, { custom: true }) as Record<string, unknown>).map((l) => ({
      line: l, use: (l.message as { content: Array<{ id: string; name: string; input: Record<string, unknown> }> }).content[0],
    }));
  };
  const commands = (cell: string) => uses(cell).filter((u) => u.use.name === 'Bash').map((u) => u.use.input.command);
  /** The Bash calls of the indexed session, as stored: one entry per Bash tool name. */
  const bashCalls = () => {
    const rows = corpus.open().prepare('SELECT tools FROM messages ORDER BY seq').pluck().all() as string[];
    return rows.flatMap((t) => t.split(' ').filter((name) => name === 'Bash'));
  };

  it('reads a single exec_command cell as one Bash call, paired with its output, at its workdir', () => {
    const p = path([
      rolloutMessage('user', 'close it'),
      rolloutCall('exec', 'const r = await tools.exec_command({cmd: "echo marker-1", workdir: "/work/app", max_output_tokens: 4000}); text(r);', 'cell', { custom: true }),
      rolloutOutput('cell', cellOut(), { custom: true }),
    ]);
    indexFile(corpus.open(), corpus.file(p));
    expect(bashCalls()).toEqual(['Bash']);
    const cell = uses('tools.exec_command({cmd: "x", workdir: "/elsewhere"})')[0];
    expect(cell.line).toMatchObject({ cwd: '/elsewhere' });
    expect(cell.line).not.toHaveProperty('gitBranch');
    expect(uses('tools.exec_command({cmd: "x", workdir: "/work/app"})')[0].line).toMatchObject({ cwd: '/work/app', gitBranch: 'feat/z' });
    expect(cell.use).toMatchObject({ id: 'cell', name: 'Bash', input: { command: 'x' } });
    const rows = corpus.open().prepare(
      `SELECT m.tools, t.tool_output FROM messages m JOIN message_text t ON t.id = m.id ORDER BY m.seq`).all() as Array<{ tools: string; tool_output: string }>;
    expect(rows[1].tools).toBe('Bash');
    expect(rows[1].tool_output).toContain('marker-1 printed');
  });

  it('extracts the exact command from a quoted key and single-quoted value', () => {
    expect(commands(`text(await tools.exec_command({"cmd": 'git commit -m "x"'}))`)).toEqual(['git commit -m "x"']);
  });

  it('decodes JavaScript escapes', () => {
    expect(commands(String.raw`tools.exec_command({cmd: "a\nb\t\"q\" \\ A \x42 \u{43} \'z\' one\
two"})`)).toEqual([`a\nb\t"q" \\ A B C 'z' onetwo`]);
    expect(commands('tools.exec_command({cmd: `echo "hi"\nls \\`x`})')).toEqual(['echo "hi"\nls `x']);
  });

  it('extracts a template literal without interpolation only', () => {
    expect(commands('tools.exec_command({cmd: `ls -la`})')).toEqual(['ls -la']);
    for (const arg of ['{cmd: `echo ${x}`}', '{cmd: c}', '{cmd}', '{cmd: "a" + b}', '{cmd: "a", ...rest}', '{cmd: "a", workdir: w}', '{cmd: "a", cmd: "b"}', '{cmd: "\\8"}', '{cmd: f("a")}']) {
      expect(commands(`const c = 1; text(await tools.exec_command(${arg}))`), arg).toEqual([]);
    }
  });

  it('stores no Bash call for a non-extractable cell even when its source has a command line', () => {
    const p = path([
      rolloutMessage('user', 'x'),
      rolloutCall('exec', 'const c = `\necho marker-1\n`;\ntext(await tools.exec_command({cmd: c}))', 'cell', { custom: true }),
      rolloutOutput('cell', cellOut(), { custom: true }),
    ]);
    indexFile(corpus.open(), corpus.file(p));
    expect(bashCalls()).toEqual([]);
  });

  it('ignores calls inside comments and inside other string literals', () => {
    const inString = 'const patch = "*** tools.exec_command({cmd: \\"echo marker-9\\"})";\ntext(patch)';
    const inTemplate = 'const patch = `tools.exec_command({cmd: "echo marker-9"})`;';
    const inComment = '// tools.exec_command({cmd: "echo marker-9"})\n/* tools.exec_command({cmd: "echo marker-9"}) */\ntext(1)';
    const inRegex = 'const re = /"tools.exec_command({cmd: "x"})/; text(re)';
    for (const cell of [inString, inTemplate, inComment, inRegex]) {
      expect(commands(cell), cell).toEqual([]);
      expect(uses(cell).map((u) => u.use.name), cell).toEqual(['exec']);
    }
    // the string-literal case as an apply_patch call inside a cell that also makes one real call
    expect(commands('await tools.apply_patch({input: "tools.exec_command({cmd: \\"echo marker-9\\"})"});\ntools.exec_command({cmd: "ls"})')).toEqual(['ls']);
  });

  it('emits exec plus numbered Bash calls for a cell with several calls; the output pairs with exec', () => {
    const cell = 'const a = await tools.exec_command({cmd: "echo marker-1"});\nconst b = await tools.exec_command({cmd: "echo marker-2", workdir: "/work/other"});\ntext(a + b)';
    const out = uses(cell, 'cell');
    expect(out.map((u) => [u.use.id, u.use.name])).toEqual([['cell', 'exec'], ['cell#1', 'Bash'], ['cell#2', 'Bash']]);
    expect(out[2].line).toMatchObject({ cwd: '/work/other' });
    const p = path([rolloutMessage('user', 'x'), rolloutCall('exec', cell, 'cell', { custom: true }), rolloutOutput('cell', cellOut(), { custom: true }), rolloutMessage('user', 'next')]);
    indexFile(corpus.open(), corpus.file(p));
    const msgs = corpus.open().prepare('SELECT t.tool_output FROM messages m JOIN message_text t ON t.id = m.id ORDER BY m.seq').all() as Array<{ tool_output: string }>;
    expect(msgs[1].tool_output).toContain('marker-1 printed'); // the exec result, once
    expect(bashCalls()).toEqual(['Bash', 'Bash']);
  });

  it('treats a cell mixing exec_command with another tool as a multi-call cell', () => {
    const cell = 'await tools.apply_patch({input: "x"});\ntext(await tools.exec_command({cmd: "git status"}))';
    expect(uses(cell).map((u) => [u.use.id, u.use.name])).toEqual([['cell', 'exec'], ['cell#1', 'Bash']]);
    expect(uses('tools.update_plan({plan: []}); text(await tools.exec_command({cmd: c}))').map((u) => u.use.name)).toEqual(['exec']);
  });

  it('marks a failed single-call cell as an error, and a good one as fine', () => {
    const file = corpus.file(path([]));
    const tr = codexRolloutFormat.translator(file, false);
    const err = (text: string) => {
      const [l] = tr.translate(rolloutOutput('cell', [{ type: 'input_text', text }], { custom: true }) as Record<string, unknown>);
      return (l.message as { content: Array<{ is_error: boolean }> }).content[0].is_error;
    };
    expect(err('Script failed\nWall time: 1 seconds')).toBe(true);
    expect(err('Script completed\nWall time: 1 seconds')).toBe(false);
    expect(err('Script completed\nWall time: 1 seconds\nChunk ID: a\nProcess exited with code 2\nOutput:\nboom')).toBe(true);
  });

  it('adds the output to the call when it arrives in a later run', () => {
    const p = path([rolloutMessage('user', 'x'), rolloutCall('exec', 'text(await tools.exec_command({cmd: "echo marker-1"}))', 'cell', { custom: true })]);
    indexFile(corpus.open(), corpus.file(p));
    const output = () => corpus.open().prepare('SELECT t.tool_output FROM messages m JOIN message_text t ON t.id = m.id ORDER BY m.seq').pluck().all();
    expect(output()[1]).toBe('');
    corpus.append(p, [rolloutOutput('cell', cellOut(), { custom: true })]);
    indexFile(corpus.open(), corpus.file(p));
    expect(bashCalls()).toEqual(['Bash']);
    expect(output()[1]).toContain('marker-1 printed');
  });

  describe('fails closed', () => {
    const lineEndProbe = (t: string) => '// c' + t + " /*\n tools.exec_command({cmd:'echo fake-1'}) \n '*/ var a = \"'\"; var b = '\"'; // '\n";

    const probes: Record<string, string> = {
      'regex after return': `function f(s){return /"/.test(s)}\nconst p = "tools.exec_command({cmd:'echo marker-9'})";`,
      'regex after a closing paren': `if (ok) /"/.test(a);\nconst p = "tools.exec_command({cmd:'echo marker-9'})";`,
      'regex at line start': `const a = 1\n/"/.test(s)\nconst p = "tools.exec_command({cmd:'echo marker-9'})";`,
      'bracket access': 'tools["apply_patch"]({}); tools.exec_command({cmd: "echo marker-9"})',
      'optional chaining': 'tools?.apply_patch({}); tools.exec_command({cmd: "echo marker-9"})',
      'space before the dot': 'tools .apply_patch({}); tools.exec_command({cmd: "echo marker-9"})',
      'comment before the dot': 'tools/* x */.apply_patch({}); tools.exec_command({cmd: "echo marker-9"})',
      'tools as a value': 'const t = tools; t.apply_patch({}); tools.exec_command({cmd: "echo marker-9"})',
      'tools in a template body': 'const s = `${tools.apply_patch({})}`; tools.exec_command({cmd: "echo marker-9"})',
      'unterminated string': 'const s = "oops; tools.exec_command({cmd: "echo marker-9"})',
      'unterminated argument': 'tools.exec_command({cmd: "echo marker-9", a: \'',
      'postfix increment then division': "const h = i++ / 2; /* tools.exec_command({cmd:'echo marker-9'}) */ x = 4 / 2;",
      'postfix increment, comment after division': "const h = i++ / 2/* tools.exec_command({cmd:'echo marker-9'}) */ / 1 / 1;",
      'postfix decrement': "const h = i-- / 2; /* tools.exec_command({cmd:'echo marker-9'}) */ x = 4 / 2;",
      'html open comment': "x = 1; <!-- tools.exec_command({cmd:'echo marker-9'})\ntext(1)",
      'html close comment': "x = 1;\n  --> tools.exec_command({cmd:'echo marker-9'})",
      'hashbang': "#! x\ntools.exec_command({cmd:'echo marker-9'})",
      'property of another object': "other.\ntools.exec_command({cmd:'echo marker-9'})",
      'property after a comment': "other. /*c*/ tools.exec_command({cmd:'echo marker-9'})",
      'optional property': "other?.tools.exec_command({cmd:'echo marker-9'})",
      'new expression': "new tools.exec_command({cmd:'echo marker-9'})",
      'line comment ended by CR': lineEndProbe('\r'),
      'line comment ended by U+2028': lineEndProbe('\u2028'),
      'line comment ended by U+2029': lineEndProbe('\u2029'),
      'html close comment after a block comment': "/*\n*/ --> tools.exec_command({cmd:'fake'})\n1;",
      'html close comment after CR': "x=1;\r--> tools.exec_command({cmd:'fake'})\n1;",
      'html close comment after U+2028': "x=1;\u2028--> tools.exec_command({cmd:'fake'})\n1;",
      'html close comment mid-line': "x=1; --> tools.exec_command({cmd:'fake'})",
      'non-ASCII identifier': "var ñ=1; ñtools.exec_command({cmd:'fake'})",
      'private name': 'x.#tools.exec_command({cmd:"y"})',
      'identifier unicode escape': "var a\\u0062 = 1; tools.exec_command({cmd:'fake'})",
      'unterminated block comment': "tools.exec_command({cmd: 'ls'}); /* never closed",
      'regex inside the argument': 'tools.exec_command({a: /"/, cmd: "echo marker-9"})',
    };
    for (const [name, cell] of Object.entries(probes)) {
      it(`extracts nothing: ${name}`, () => {
        expect(uses(cell).map((u) => [u.use.id, u.use.name]), name).toEqual([['cell', 'exec']]);
        expect(scanCell(cell).uncertain).toBe(true);
        const p = path([rolloutMessage('user', 'x'), rolloutCall('exec', cell, 'cell', { custom: true }), rolloutOutput('cell', cellOut(), { custom: true }), rolloutMessage('user', 'y')]);
        indexFile(corpus.open(), corpus.file(p));
        expect(bashCalls()).toEqual([]);
      });
    }

    describe('a call a short-circuit, conditional or rebinding may skip or fake', () => {
      const always: Record<string, string> = {
        'optional call': "q?.(tools.exec_command({cmd:'echo fake-1'}))",
        'nullish coalescing': "null ?? tools.exec_command({cmd:'echo fake-1'})",
        'nullish assignment': "v ??= tools.exec_command({cmd:'echo fake-1'})",
        'logical or assignment': "v ||= tools.exec_command({cmd:'echo fake-1'})",
        'logical and assignment': "v &&= tools.exec_command({cmd:'echo fake-1'})",
        'eval rebinding': "eval('var tools={exec_command(){}}'); tools.exec_command({cmd:'echo fake-1'})",
        'with statement': "with(o) tools.exec_command({cmd:'echo fake-1'})",
        'Function constructor': "Function('x')(); tools.exec_command({cmd:'echo fake-1'})",
        'globalThis': "globalThis.tools = {}; tools.exec_command({cmd:'echo fake-1'})",
        'Reflect': "Reflect.set(o, 'tools', 1); tools.exec_command({cmd:'echo fake-1'})",
        'eval in a template body': "`${eval('1')}`; tools.exec_command({cmd:'echo fake-1'})",
        'nullish in a template body': "`${a ?? b}`; tools.exec_command({cmd:'echo fake-1'})",
      };
      const grouped: Record<string, string> = {
        'logical and': "false && tools.exec_command({cmd:'echo fake-1'})",
        'logical or': "true || tools.exec_command({cmd:'echo fake-1'})",
        'ternary': "c ? tools.exec_command({cmd:'echo fake-1'}) : 0",
        'ternary with a leading-dot number': "c ?.5 : tools.exec_command({cmd:'echo fake-1'})",
        'logical and in a template body': "`${a && b}`; tools.exec_command({cmd:'echo fake-1'})",
      };
      for (const [name, cell] of Object.entries(always)) {
        it(`extracts nothing: ${name}`, () => {
          expect(scanCell(cell)).toMatchObject({ uncertain: true, execCommands: [] });
          expect(commands(cell)).toEqual([]);
        });
      }
      for (const [name, cell] of Object.entries(grouped)) {
        it(`follows ${'UNCERTAIN_ON_SHORT_CIRCUIT_AND_TERNARY'}: ${name}`, () => {
          if (UNCERTAIN_ON_SHORT_CIRCUIT_AND_TERNARY) {
            expect(scanCell(cell)).toMatchObject({ uncertain: true, execCommands: [] });
            expect(commands(cell)).toEqual([]);
          } else {
            expect(scanCell(cell).uncertain).toBe(false);
          }
        });
      }
      it('still extracts from an ordinary cell, and ignores these tokens in strings and comments', () => {
        expect(commands('const r = await tools.exec_command({cmd: "git status", workdir: "/w"}); text(r);')).toEqual(['git status']);
        const quoted = [
          'const s = "a ? b || c && d ?? e ?. f"; text(await tools.exec_command({cmd: "git status"}))',
          "// eval? with || Function && globalThis ??\ntext(await tools.exec_command({cmd: 'git status'}))",
          '/* Reflect ? : */ text(await tools.exec_command({cmd: `echo a || b && c ? d`}))',
          'text(await tools.exec_command({cmd: "test -f x && echo yes || echo no"}))',
          'const evaluate = 1, withdraw = 2, myeval = 3; text(await tools.exec_command({cmd: "git status"}))',
        ];
        expect(commands(quoted[0])).toEqual(['git status']);
        expect(commands(quoted[1])).toEqual(['git status']);
        expect(commands(quoted[2])).toEqual(['echo a || b && c ? d']);
        expect(commands(quoted[3])).toEqual(['test -f x && echo yes || echo no']);
        expect(commands(quoted[4])).toEqual(['git status']);
        for (const cell of quoted) expect(scanCell(cell).uncertain, cell).toBe(false);
      });
    });

    it('marks any division or regex literal uncertain, and still extracts with comments and URLs in strings', () => {
      // No regex-versus-division decision is made (every heuristic leaked), so a bare `/` aborts the scan.
      expect(commands('const x = a / b; text(await tools.exec_command({cmd: "git status"}))')).toEqual([]);
      expect(commands('const re = /a"b/g; text(await tools.exec_command({cmd: "git status"}))')).toEqual([]);
      expect(commands('// note\n/* block */ const u = "https://example.org/x"; // tail\ntext(await tools.exec_command({cmd: "git status"}))')).toEqual(['git status']);
    });

    it('still extracts from CRLF cells and non-ASCII text inside strings and comments', () => {
      expect(commands('const r = await tools.exec_command({cmd: "git status"});\r\ntext(r);\r\n')).toEqual(['git status']);
      expect(commands('// héllo → note\ntext(await tools.exec_command({cmd: "echo héllo → ok"}))')).toEqual(['echo héllo → ok']);
      expect(commands('/* ñ */ text(await tools.exec_command({cmd: `echo ñ`}))')).toEqual(['echo ñ']);
    });

    it('survives pathological nesting without throwing', () => {
      const cell = '`${'.repeat(10_000) + 'tools.exec_command({cmd: "x"})';
      expect(() => scanCell(cell)).not.toThrow();
      expect(uses(cell).map((u) => u.use.name)).toEqual(['exec']);
    });

    it('is fast on an unterminated call repeated many times, and skips oversized cells', () => {
      const unit = "tools.exec_command({a:'";
      const big = unit.repeat(9_000); // about 200 KB: scanned, and uncertain at the first call
      let start = Date.now();
      expect(uses(big).map((u) => u.use.name)).toEqual(['exec']);
      const huge = unit.repeat(20_000); // about 460 KB: not scanned at all
      expect(uses(huge).map((u) => u.use.name)).toEqual(['exec']);
      expect(scanCell(huge).uncertain).toBe(true);
      expect(Date.now() - start).toBeLessThan(1000);
      start = Date.now();
      const cell = 'tools.exec_command({cmd: "ls"});\n'.repeat(65);
      expect(scanCell(cell)).toMatchObject({ uncertain: true, execCommands: [] }); // over the per-cell cap
      expect(scanCell('tools.exec_command({cmd: "ls"});\n'.repeat(64)).execCommands).toHaveLength(64);
    });
  });
});

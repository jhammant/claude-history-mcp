import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rebuild } from '../../src/indexing/rebuild.js';
import { REPLAY_BURST_GAP_MS } from '../../src/formats/codex-rollout.js';
import { readFirstLine, readHeadLines } from '../../src/formats/fs-util.js';
import { indexFile } from '../../src/indexing/indexer.js';
import { sweep } from '../../src/indexing/sweep.js';
import {
  createCorpus, rolloutCall, rolloutEvent, rolloutMessage, rolloutMeta, rolloutOutput, rolloutTurn, type Corpus,
} from '../helpers/corpus.js';

/*
 * Synthetic forked rollouts mirroring the structure surveyed in real files (see the header of
 * src/formats/codex-rollout.ts): the fork's own session_meta, the parent's session_meta and
 * history replayed in one burst at fork time, then the fork's own lines.
 */

const PARENT = '0199bbbb-0000-7000-8000-00000000000a';
const FORK = '0199bbbb-0000-7000-8000-00000000000b';
const DATE = '2026-10-01';
const T0 = Date.parse('2026-10-01T09:00:00Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();
const out = (text: string) => `Chunk ID: ab12\nWall time: 0.1 seconds\nProcess exited with code 0\nOriginal token count: 9\nOutput:\n${text}\n`;

type Line = Record<string, unknown>;
type Opts = { timestamp: string; ordinal?: number };

/** The parent's history: a turn at another cwd, a prompt, a command and a commit with outputs, a compaction, an answer. */
function parentLines(o: (i: number) => Opts): Line[] {
  return [
    rolloutTurn('/work/parent-turn', o(0)),
    rolloutMessage('user', 'parent prompt', o(1)),
    rolloutCall('exec_command', { cmd: 'echo marker-1 --reason done', workdir: '/work/app' }, 'p-1', o(2)),
    rolloutOutput('p-1', out('marker-1 printed'), o(3)),
    rolloutCall('exec_command', { cmd: 'git commit -m "feat: parent work"', workdir: '/work/app' }, 'p-2', o(4)),
    rolloutOutput('p-2', out('[main 1111111] feat: parent work\n 1 file changed'), o(5)),
    { ...o(6), type: 'compacted', payload: { message: 'summary', replacement_history: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'parent prompt' }] }] } },
    rolloutMessage('assistant', 'parent answer', o(7)),
  ] as Line[];
}

/** The fork's own lines: a prompt, a command and a commit with outputs, an answer. */
function ownLines(o: (i: number) => Opts): Line[] {
  return [
    rolloutMessage('user', 'fork task', o(0)),
    rolloutCall('exec_command', { cmd: 'echo marker-2 --reason done', workdir: '/work/app' }, 'f-1', o(1)),
    rolloutOutput('f-1', out('marker-2 printed'), o(2)),
    rolloutCall('exec_command', { cmd: 'git commit -m "feat: fork work"', workdir: '/work/app' }, 'f-2', o(3)),
    rolloutOutput('f-2', out('[main 2222222] feat: fork work\n 1 file changed'), o(4)),
    rolloutMessage('assistant', 'fork done', o(5)),
  ] as Line[];
}

const SUBAGENT = {
  forked_from_id: PARENT, parent_thread_id: PARENT, thread_source: 'subagent', agent_nickname: 'Scout',
  source: { subagent: { thread_spawn: { parent_thread_id: PARENT, depth: 1, agent_nickname: 'Scout', agent_role: 'worker' } } },
};

/** The fork's header: its own cwd, branch and remote, which the parent's must never replace. */
function forkMeta(extra: Record<string, unknown>, opts: Partial<Opts> = {}): Line {
  return rolloutMeta(FORK, {
    timestamp: at(0), ...opts, cwd: '/work/app', branch: 'fork-branch', repositoryUrl: 'https://git.example.org/team/fork.git', extra,
  }) as Line;
}

function parentMeta(opts: Opts): Line {
  return rolloutMeta(PARENT, { ...opts, cwd: '/work/parent', branch: 'parent-branch', repositoryUrl: 'https://git.example.org/team/parent.git' }) as Line;
}

/** A paginated subagent fork: every line carries its ordinal, and the header names where its own history starts. */
function ordinalFork(): Line[] {
  const replay = parentLines((i) => ({ timestamp: at(1 + i), ordinal: 2 + i }));
  let n = 2 + replay.length;
  const tail = [
    rolloutMessage('developer', 'subagent instructions', { timestamp: at(12), ordinal: n++ }),
  ] as Line[];
  const start = n;
  const own = [
    rolloutEvent('thread_settings_applied', {}, { timestamp: at(90), ordinal: n++ }),
    rolloutEvent('task_started', {}, { timestamp: at(150), ordinal: n++ }),
    rolloutTurn('/work/app', { timestamp: at(2000), ordinal: n++ }),
    ...ownLines((i) => ({ timestamp: at(2100 + i * 100), ordinal: n + i })),
  ] as Line[];
  return [
    forkMeta({ ...SUBAGENT, history_mode: 'paginated', multi_agent_version: 2, subagent_history_start_ordinal: start }, { ordinal: 0 }),
    parentMeta({ timestamp: at(1), ordinal: 1 }),
    ...replay, ...tail, ...own,
  ];
}

/** An older fork that states no boundary: the replay is the burst written at fork time. */
function burstFork(extra: Record<string, unknown> = { ...SUBAGENT, history_mode: 'legacy' }): Line[] {
  return [
    forkMeta(extra),
    parentMeta({ timestamp: at(1) }),
    ...parentLines((i) => ({ timestamp: at(2 + i) })),
    rolloutEvent('task_started', {}, { timestamp: at(20) }),
    rolloutTurn('/work/app', { timestamp: at(1500) }),
    ...ownLines((i) => ({ timestamp: at(1600 + i * 100) })),
  ];
}

describe('forked codex rollouts', () => {
  let corpus: Corpus;
  beforeEach(() => { corpus = createCorpus(); });
  afterEach(() => corpus.cleanup());

  const id = `codex-${FORK}`;
  const session = (sid = id) => corpus.open().prepare(
    'SELECT is_subagent, parent_session, cwd, git_branch, git_remote, first_prompt, start_time, end_time, message_count FROM sessions WHERE id = ?',
  ).get(sid) as Record<string, unknown>;
  const rows = (sid = id) => corpus.open().prepare(
    `SELECT m.role, m.tools, t.prose, t.tool_input FROM messages m JOIN message_text t ON t.id = m.id
     JOIN sessions s ON s.sid = m.session_sid WHERE s.id = ? ORDER BY m.seq`,
  ).all(sid) as Array<{ role: string; tools: string; prose: string; tool_input: string }>;
  const write = (lines: Line[], uuid = FORK) => corpus.write(corpus.rolloutPath(DATE, uuid), lines);
  const index = (path: string, batchBytes?: number) => indexFile(corpus.open(), corpus.file(path), batchBytes ? { batchBytes } : {});

  /** What the fork must hold: its own four rows and its own metadata. */
  function expectOnlyOwn() {
    const r = rows();
    expect(r.map((m) => [m.role, m.prose])).toEqual([
      ['user', 'fork task'], ['assistant', ''], ['assistant', ''], ['assistant', 'fork done'],
    ]);
    expect(r.map((m) => m.tool_input).join('\n')).not.toContain('marker-1');
    expect(r.map((m) => m.tool_input).join('\n')).not.toContain('parent work');
    expect(r.map((m) => m.tool_input).join('\n')).toContain('fork work');
    expect(session()).toMatchObject({
      cwd: '/work/app', git_branch: 'fork-branch', git_remote: 'https://git.example.org/team/fork.git',
      first_prompt: 'fork task', message_count: 4,
    });
    expect(session().start_time).toBeGreaterThanOrEqual(T0 + 1500);
  }

  it('skips the replay of a subagent fork below subagent_history_start_ordinal', () => {
    index(write(ordinalFork()));
    expectOnlyOwn();
  });

  it('skips the replay of a fork that states no boundary (the fork-time burst)', () => {
    index(write(burstFork()));
    expectOnlyOwn();
  });

  it('skips the replay of a user fork (source cli)', () => {
    index(write(burstFork({ forked_from_id: PARENT, source: 'cli', thread_source: 'user', history_mode: 'legacy' })));
    expectOnlyOwn();
    expect(session()).toMatchObject({ is_subagent: 0, parent_session: null });
  });

  it('skips the replay a CLI 0.66 file marks only by the other thread\'s session_meta on line 1', () => {
    index(write(burstFork({ source: 'cli' })));
    expectOnlyOwn();
  });

  it('reads a paginated user fork with history_base whole: its history stays in the base file', () => {
    const lines = [
      forkMeta({ forked_from_id: PARENT, source: 'cli', history_mode: 'paginated', history_base: { thread_id: PARENT, end_ordinal_exclusive: 40, end_byte_offset: 9000 } }, { ordinal: 40 }),
      ...ownLines((i) => ({ timestamp: at(1 + i), ordinal: 41 + i })),
    ];
    index(write(lines));
    expect(rows().map((m) => m.prose)).toEqual(['fork task', '', '', 'fork done']);
  });

  for (const [name, build] of [['ordinal', ordinalFork], ['burst', () => burstFork()]] as const) {
    it(`skips the replay when the file is read in small batches (${name})`, () => {
      index(write(build()), 300);
      expectOnlyOwn();
    });

    it(`skips the replay when the first read stops inside it and a later read resumes (${name})`, () => {
      const lines = build();
      const path = write(lines.slice(0, 5)); // header, parent meta, part of the replay
      index(path);
      expect(rows()).toEqual([]);
      corpus.append(path, lines.slice(5, 9));
      index(path);
      corpus.append(path, lines.slice(9));
      index(path);
      expectOnlyOwn();
    });

    it(`reads an indexed fork the same in a rebuild (${name})`, async () => {
      write(build());
      sweep(corpus.open());
      await rebuild(join(corpus.dataDir, 'history.db'));
      expectOnlyOwn();
    });
  }

  it('keeps the parent\'s replayed session_meta from replacing the fork\'s on a resumed read', () => {
    const lines = ordinalFork();
    const path = write(lines.slice(0, 2));
    index(path);
    corpus.append(path, lines.slice(2));
    index(path);
    expectOnlyOwn();
  });

  it('reads a non-fork rollout whole, however close together its lines are stamped', () => {
    const lines = [
      rolloutMeta(PARENT, { timestamp: at(0) }),
      ...parentLines((i) => ({ timestamp: at(1 + i) })),
      ...ownLines((i) => ({ timestamp: at(10 + i) })),
    ] as Line[];
    index(write(lines, PARENT));
    expect(rows(`codex-${PARENT}`).map((m) => m.prose)).toEqual(['parent prompt', '', '', 'parent answer', 'fork task', '', '', 'fork done']);
    expect(rows(`codex-${PARENT}`).map((m) => m.tool_input).join('\n')).toMatch(/marker-1[\s\S]*marker-2/);
  });

  it('ends the burst at the first gap longer than REPLAY_BURST_GAP_MS', () => {
    const lines = [
      forkMeta({ ...SUBAGENT, history_mode: 'legacy' }),
      parentMeta({ timestamp: at(1) }),
      rolloutMessage('user', 'replayed', { timestamp: at(1 + REPLAY_BURST_GAP_MS) }), // still the burst: gap == the limit
      rolloutMessage('user', 'own', { timestamp: at(2 + 2 * REPLAY_BURST_GAP_MS) }),
      rolloutMessage('user', 'own, stamped early', { timestamp: at(0) }), // after the burst: never skipped
    ] as Line[];
    index(write(lines));
    expect(rows().map((m) => m.prose)).toEqual(['own', 'own, stamped early']);
  });

  it('indexes the history before the fork under the parent only, and the work after it under the fork', () => {
    // The parent's own rollout: the history the fork replays.
    write([
      rolloutMeta(PARENT, { timestamp: at(0), extra: {} }),
      ...parentLines((i) => ({ timestamp: at(1 + i) })),
    ] as Line[], PARENT);
    write(ordinalFork());
    sweep(corpus.open());
    const tools = (sid: string) => rows(sid).map((m) => m.tool_input).join('\n');
    expect(tools(`codex-${PARENT}`)).toContain('marker-1');
    expect(tools(`codex-${PARENT}`)).toContain('parent work');
    expect(tools(`codex-${PARENT}`)).not.toContain('marker-2');
    expect(tools(id)).toContain('marker-2');
    expect(tools(id)).not.toContain('marker-1');
    expect(tools(id)).not.toContain('parent work');
  });

  describe('burst rule: every way of reading cuts at the same line', () => {
    /** The fork's own lines, then a later line that has no timestamp or one stepping backwards. */
    const later = (kind: 'no timestamp' | 'backwards'): Line => {
      const line = rolloutMessage('user', 'later own line', { timestamp: at(0) }) as Line;
      if (kind === 'no timestamp') delete line.timestamp;
      return line;
    };
    for (const kind of ['no timestamp', 'backwards'] as const) {
      it(`a resumed read past the replay keeps a first line with ${kind === 'backwards' ? 'a timestamp stepping backwards' : 'no timestamp'}`, () => {
        const lines = [...burstFork(), later(kind), rolloutMessage('assistant', 'last', { timestamp: at(9000) }) as Line];
        const expected = ['fork task', '', '', 'fork done', 'later own line', 'last'];
        // Full read.
        const full = write(lines);
        index(full);
        expect(rows().map((m) => m.prose)).toEqual(expected);
        // The same file read up to the end of the fork's first part, then resumed at the odd line.
        corpus.cleanup();
        corpus = createCorpus();
        const path = write(lines.slice(0, -2));
        index(path);
        corpus.append(path, lines.slice(-2));
        index(path);
        expect(rows().map((m) => m.prose)).toEqual(expected);
      });
    }

    it('times the burst from line 1, so a header stamped seconds earlier still has its replay skipped', () => {
      const lines = burstFork().map((l, i) => (i === 0 ? l : { ...l, timestamp: new Date(Date.parse(l.timestamp as string) + 5000).toISOString() }));
      index(write(lines));
      expectOnlyOwn();
    });

    it('is not applied to a paginated fork that states neither a start ordinal nor history_base', () => {
      index(write(burstFork({ ...SUBAGENT, history_mode: 'paginated' })));
      expect(rows().map((m) => m.prose)).toEqual(['parent prompt', '', '', 'parent answer', 'fork task', '', '', 'fork done']);
    });
  });

  it('takes the session cwd and first prompt of a real subagent fork from its header and spawn task', () => {
    const header = forkMeta({ ...SUBAGENT, agent_path: '/root/scout', history_mode: 'paginated', subagent_history_start_ordinal: 3 }, { ordinal: 0 });
    const task = (recipient: string, text: string, ordinal: number) => ({
      timestamp: at(2100 + ordinal), ordinal, type: 'response_item',
      payload: {
        type: 'agent_message', author: '/root', recipient, id: `am-${ordinal}`, internal_chat_message_metadata_passthrough: {},
        content: [{ type: 'encrypted_content', encrypted_content: 'x' }, { type: 'input_text', text }],
      },
    });
    index(write([
      header,
      parentMeta({ timestamp: at(1), ordinal: 1 }),
      rolloutMessage('user', 'parent prompt', { timestamp: at(2), ordinal: 2 }),
      rolloutEvent('thread_settings_applied', {}, { timestamp: at(90), ordinal: 3 }),
      { timestamp: at(2000), ordinal: 4, type: 'inter_agent_communication_metadata', payload: { trigger_turn: true } },
      task('/root/scout', 'Survey the parser and report', 5),
      rolloutCall('exec_command', { cmd: 'ls', workdir: '/work/app/src/parser' }, 'c-1', { timestamp: at(2200), ordinal: 6 }),
      rolloutOutput('c-1', out('a.ts'), { timestamp: at(2300), ordinal: 7 }),
      task('/root/scout', 'a later message is not the first prompt', 8),
    ] as Line[]));
    expect(session()).toMatchObject({ cwd: '/work/app', first_prompt: 'Survey the parser and report', message_count: 1 });
    expect(corpus.open().prepare('SELECT project FROM sessions WHERE id = ?').get(id)).toEqual({ project: '-work-app' });
    expect(rows().map((m) => m.tools)).toEqual(['Bash']);
  });

  it('takes the same first prompt on a full and a resumed read when the first task message has no usable text', () => {
    const header = forkMeta({ ...SUBAGENT, agent_path: '/root/scout', history_mode: 'paginated', subagent_history_start_ordinal: 3 }, { ordinal: 0 });
    const task = (text: string | null, ordinal: number) => ({
      timestamp: at(2100 + ordinal), ordinal, type: 'response_item',
      payload: {
        type: 'agent_message', author: '/root', recipient: '/root/scout', id: `am-${ordinal}`,
        content: text === null ? [{ type: 'encrypted_content', encrypted_content: 'x' }] : [{ type: 'input_text', text }],
      },
    });
    const lines = [
      header,
      parentMeta({ timestamp: at(1), ordinal: 1 }),
      rolloutMessage('user', 'parent prompt', { timestamp: at(2), ordinal: 2 }),
      rolloutEvent('thread_settings_applied', {}, { timestamp: at(90), ordinal: 3 }),
      task(null, 4),
      task('<environment_context>\n<cwd>/work/app</cwd>\n</environment_context>', 5),
      task('Survey the parser and report', 6),
      rolloutCall('exec_command', { cmd: 'ls', workdir: '/work/app' }, 'c-1', { timestamp: at(2200), ordinal: 7 }),
    ] as Line[];
    index(write(lines));
    const full = session().first_prompt;
    expect(full).toBe('Survey the parser and report');

    // The same file in a fresh index, read in two parts: the first stops after the empty and
    // the injected-only message.
    const second = createCorpus();
    try {
      const path = second.write(second.rolloutPath(DATE, FORK), lines.slice(0, 6));
      indexFile(second.open(), second.file(path), {});
      second.append(path, lines.slice(6));
      indexFile(second.open(), second.file(path), {});
      expect(second.open().prepare('SELECT first_prompt FROM sessions WHERE id = ?').get(id)).toEqual({ first_prompt: full });
    } finally {
      second.cleanup();
    }
  });

  it('applies a non-fork\'s first session_meta with an id when line 1 is not one, as before', () => {
    index(write([
      rolloutTurn('/work/elsewhere', { timestamp: at(0) }),
      rolloutMeta(PARENT, { timestamp: at(1), cwd: '/work/app', branch: 'main' }),
      rolloutMessage('user', 'hello', { timestamp: at(2) }),
    ] as Line[], PARENT));
    expect(session(`codex-${PARENT}`)).toMatchObject({ git_branch: 'main' });
  });

  it('leaves a non-fork session\'s cwd and first prompt as before (agent_message is no first prompt there)', () => {
    index(write([
      rolloutMeta(PARENT, { timestamp: at(0), cwd: '/work/app', extra: { thread_source: 'subagent', agent_path: '/root/w' } }),
      { timestamp: at(1), type: 'response_item', payload: { type: 'agent_message', author: '/root', recipient: '/root/w', content: [{ type: 'input_text', text: 'task' }] } },
      rolloutCall('exec_command', { cmd: 'ls', workdir: '/work/app/sub' }, 'c-1', { timestamp: at(2) }),
    ] as Line[], PARENT));
    expect(session(`codex-${PARENT}`)).toMatchObject({ cwd: '/work/app/sub', first_prompt: null });
  });

  it('skips everything when the start ordinal is past the end of the file (the file says so)', () => {
    const lines = ordinalFork();
    (lines[0].payload as Record<string, unknown>).subagent_history_start_ordinal = lines.length + 10;
    index(write(lines));
    expect(rows()).toEqual([]);
  });

  it('never applies a replayed session_meta without an id', () => {
    const lines = burstFork();
    delete (lines[1].payload as Record<string, unknown>).id;
    // Mark the replay by forked_from_id (already in the header); a second id-less meta later on too.
    lines.splice(5, 0, { ...lines[1], timestamp: at(4) });
    index(write(lines));
    expectOnlyOwn();
  });

  it('reads a non-fork paginated file with ordinals but no start ordinal whole', () => {
    const lines = [
      rolloutMeta(PARENT, { timestamp: at(0), ordinal: 0, extra: { history_mode: 'paginated' } }),
      ...parentLines((i) => ({ timestamp: at(1 + i), ordinal: 1 + i })),
    ] as Line[];
    index(write(lines, PARENT));
    expect(rows(`codex-${PARENT}`).map((m) => m.prose)).toEqual(['parent prompt', '', '', 'parent answer']);
  });

  it('skips nothing when the header is over the head-read cap, as before', () => {
    const lines = burstFork();
    (lines[0].payload as Record<string, unknown>).base_instructions = { text: 'y'.repeat(4_400_000) };
    index(write(lines));
    expect(rows().map((m) => m.prose)).toEqual(['parent prompt', '', '', 'parent answer', 'fork task', '', '', 'fork done']);
  });
});

describe('head reads', () => {
  let corpus: Corpus;
  beforeEach(() => { corpus = createCorpus(); });
  afterEach(() => corpus.cleanup());

  // readFirstLine is HEAD's code unchanged: a first line is kept when its newline lies within
  // the first 4 MiB (the 64 KiB chunks stop at the cap). readHeadLines keeps the same limit.
  const file = (name: string, text: string) => {
    const path = corpus.write(`${corpus.root}/x/${name}.jsonl`, []);
    corpus.appendRaw(path, text);
    return path;
  };
  it('keep a first line up to the cap, as readFirstLine always has', () => {
    const atCap = 'z'.repeat((4 << 20) - 1);
    const path = file('at-cap', `${atCap}\nsecond\n`);
    expect(readFirstLine(path)).toBe(atCap);
    expect(readHeadLines(path, 2)).toEqual([atCap, 'second']);
  });
  it('drop a first line past the cap, as readFirstLine always has', () => {
    for (const extra of [1000, 128 << 10]) {
      const path = file(`over-${extra}`, `${'z'.repeat((4 << 20) + extra)}\nsecond\n`);
      expect(readFirstLine(path)).toBeNull();
      expect(readHeadLines(path, 2)).toEqual([]);
    }
  });
  it('read an unterminated last line and stop at the count', () => {
    expect(readHeadLines(file('short', 'a\nb\nc'), 2)).toEqual(['a', 'b']);
    expect(readHeadLines(file('open', 'a\nb'), 5)).toEqual(['a', 'b']);
    expect(readFirstLine(file('one', 'only'))).toBe('only');
  });
});

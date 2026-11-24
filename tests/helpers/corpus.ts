/**
 * Synthetic transcripts in a temp directory, and the environment that points the code
 * at them. Nothing here reads or writes real history.
 */

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { openDatabase, type DB } from '../../src/db/database.js';
import type { TranscriptFile } from '../../src/parsers/transcript-files.js';
import { listTranscripts } from '../../src/parsers/transcript-files.js';

const ENV_KEYS = ['CLAUDE_HISTORY_DATA_DIR', 'CLAUDE_HISTORY_PROJECTS_DIR', 'CLAUDE_HISTORY_CLAUDE_DIR',
  'CODEX_TRANSCRIPT_FEED', 'CLAUDE_HISTORY_CODEX_SESSIONS_DIR', 'CLAUDE_HISTORY_PI_SESSIONS_DIR', 'CODEX_HOME', 'CLAUDE_HISTORY_TOPUP_MS'] as const;

export interface Corpus {
  root: string;
  projects: string;
  codexFeed: string;
  /** Root of the native Codex rollout tree (YYYY/MM/DD/rollout-*.jsonl). */
  codexSessions: string;
  /** Root of the native pi session tree (<encoded-cwd>/<timestamp>_<uuid>.jsonl). */
  piSessions: string;
  dataDir: string;
  env: Record<string, string>;
  /** Path of a top-level Claude session transcript. */
  sessionPath(project: string, sessionId: string): string;
  subagentPath(project: string, parentId: string, agentId: string, nested?: string): string;
  codexPath(project: string, sessionId: string): string;
  /** Path of a native Codex rollout file; `date` is YYYY-MM-DD. */
  rolloutPath(date: string, uuid: string): string;
  /** Path of a pi session file in a cwd directory such as `--work-app--`. */
  piPath(dir: string, uuid: string): string;
  write(path: string, lines: object[]): string;
  append(path: string, lines: object[]): void;
  /** Append raw text (e.g. half a line). */
  appendRaw(path: string, text: string): void;
  open(): DB;
  file(path: string): TranscriptFile;
  cleanup(): void;
}

export function createCorpus(): Corpus {
  const root = mkdtempSync(join(tmpdir(), 'history-test-'));
  const projects = join(root, 'claude', 'projects');
  const codexFeed = join(root, 'codex-feed');
  const codexSessions = join(root, 'codex-sessions');
  const piSessions = join(root, 'pi-sessions');
  const dataDir = join(root, 'data');
  mkdirSync(projects, { recursive: true });
  mkdirSync(join(codexFeed, 'projects'), { recursive: true });
  const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const env = {
    CLAUDE_HISTORY_DATA_DIR: dataDir,
    CLAUDE_HISTORY_PROJECTS_DIR: projects,
    CLAUDE_HISTORY_CLAUDE_DIR: join(root, 'claude'),
    CODEX_TRANSCRIPT_FEED: codexFeed,
    CLAUDE_HISTORY_CODEX_SESSIONS_DIR: codexSessions,
    CLAUDE_HISTORY_PI_SESSIONS_DIR: piSessions,
    CLAUDE_HISTORY_TOPUP_MS: '300',
  };
  Object.assign(process.env, env);
  delete process.env.CODEX_HOME;
  const toText = (lines: object[]) => lines.map((l) => JSON.stringify(l) + '\n').join('');
  let db: DB | undefined;

  return {
    root, projects, codexFeed, codexSessions, piSessions, dataDir, env,
    sessionPath: (project, sessionId) => join(projects, project, `${sessionId}.jsonl`),
    subagentPath: (project, parentId, agentId, nested) =>
      join(projects, project, parentId, 'subagents', ...(nested ? [nested] : []), `agent-${agentId}.jsonl`),
    codexPath: (project, sessionId) => join(codexFeed, 'projects', project, `${sessionId}.jsonl`),
    rolloutPath: (date, uuid) => join(codexSessions, ...date.split('-'), `rollout-${date}T10-00-00-${uuid}.jsonl`),
    piPath: (dir, uuid) => join(piSessions, dir, `2026-10-01T10-00-00-000Z_${uuid}.jsonl`),
    write(path, lines) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, toText(lines));
      return path;
    },
    append(path, lines) {
      appendFileSync(path, toText(lines));
    },
    appendRaw(path, text) {
      appendFileSync(path, text);
    },
    open() {
      db ??= openDatabase(join(dataDir, 'history.db'), { create: true });
      return db;
    },
    file(path) {
      const found = listTranscripts().find((f) => f.path === path);
      if (!found) throw new Error(`fixture transcript not found: ${path}`);
      return found;
    },
    cleanup() {
      db?.close();
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

// ------------------------------------------------------------------ line builders

let clock = Date.parse('2026-10-01T09:00:00Z');
export function resetClock(iso = '2026-10-01T09:00:00Z'): void {
  clock = Date.parse(iso);
}
function nextTs(): string {
  clock += 60_000;
  return new Date(clock).toISOString();
}

interface Common {
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  timestamp?: string;
}

function common(opts: Common) {
  return {
    sessionId: opts.sessionId ?? 'fixture',
    cwd: opts.cwd ?? '/work/app',
    gitBranch: opts.gitBranch ?? 'main',
    timestamp: opts.timestamp ?? nextTs(),
  };
}

export function userLine(text: string, opts: Common & { isMeta?: boolean } = {}) {
  return { type: 'user', ...common(opts), ...(opts.isMeta ? { isMeta: true } : {}), message: { role: 'user', content: text } };
}

export function assistantText(text: string, opts: Common & { id?: string } = {}) {
  return { type: 'assistant', ...common(opts), message: { id: opts.id ?? `msg-${Math.random()}`, role: 'assistant', content: [{ type: 'text', text }] } };
}

export function assistantThinking(thinking: string, opts: Common & { id?: string } = {}) {
  return { type: 'assistant', ...common(opts), message: { id: opts.id ?? `msg-${Math.random()}`, role: 'assistant', content: [{ type: 'thinking', thinking }] } };
}

export function toolUse(name: string, input: object, opts: Common & { id?: string; toolUseId?: string } = {}) {
  return {
    type: 'assistant', ...common(opts),
    message: { id: opts.id ?? `msg-${Math.random()}`, role: 'assistant', content: [{ type: 'tool_use', id: opts.toolUseId ?? 'tu', name, input }] },
  };
}

export function toolResult(content: string | object[], opts: Common & { toolUseId?: string } = {}) {
  return {
    type: 'user', ...common(opts),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: opts.toolUseId ?? 'tu', content }] },
  };
}

export function codexLine(role: 'user' | 'assistant', text: string, opts: Common = {}) {
  return { type: role, source_provider: 'codex', ...common(opts), message: { role, content: text } };
}

// ------------------------------------------------------------------ Codex rollout line builders

interface RolloutOpts {
  timestamp?: string;
  ordinal?: number;
}

function rollout(type: string, payload: object, opts: RolloutOpts = {}) {
  return { timestamp: opts.timestamp ?? nextTs(), ...(opts.ordinal !== undefined ? { ordinal: opts.ordinal } : {}), type, payload };
}

export function rolloutMeta(
  uuid: string,
  opts: RolloutOpts & {
    cwd?: string; branch?: string; threadSource?: string; parentThreadId?: string;
    /** More payload keys (forked_from_id, subagent_history_start_ordinal, history_mode, source ...). */
    extra?: Record<string, unknown>;
  } = {},
) {
  return rollout('session_meta', {
    id: uuid, timestamp: opts.timestamp ?? '2026-10-01T09:00:00Z', cwd: opts.cwd ?? '/work/app', originator: 'codex_cli_rs', cli_version: '0.0.0',
    // Real Codex headers also carry repository_url; the parser ignores it, and this keeps the fixture realistic.
    git: { branch: opts.branch ?? 'main', commit_hash: 'abc', repository_url: 'https://git.example.org/team/app.git' },
    ...(opts.threadSource ? { thread_source: opts.threadSource } : {}),
    ...(opts.parentThreadId ? { parent_thread_id: opts.parentThreadId } : {}),
    ...opts.extra,
  }, opts);
}

export function rolloutTurn(cwd: string, opts: RolloutOpts = {}) {
  return rollout('turn_context', { cwd, model: 'test-model' }, opts);
}

export function rolloutMessage(role: 'user' | 'assistant' | 'developer', text: string, opts: RolloutOpts = {}) {
  const type = role === 'assistant' ? 'output_text' : 'input_text';
  return rollout('response_item', { type: 'message', role, content: [{ type, text }] }, opts);
}

export function rolloutCall(name: string, args: object | string, callId: string, opts: RolloutOpts & { custom?: boolean } = {}) {
  return rollout('response_item', opts.custom
    ? { type: 'custom_tool_call', name, input: typeof args === 'string' ? args : JSON.stringify(args), call_id: callId, status: 'completed' }
    : { type: 'function_call', name, arguments: typeof args === 'string' ? args : JSON.stringify(args), call_id: callId }, opts);
}

export function rolloutOutput(callId: string, output: string | object[], opts: RolloutOpts & { custom?: boolean } = {}) {
  return rollout('response_item', { type: opts.custom ? 'custom_tool_call_output' : 'function_call_output', call_id: callId, output }, opts);
}

export function rolloutEvent(type: string, payload: object = {}, opts: RolloutOpts = {}) {
  return rollout('event_msg', { type, ...payload }, opts);
}

// ------------------------------------------------------------------ pi line builders

interface PiOpts {
  timestamp?: string;
  id?: string;
  parentId?: string | null;
}

let piCounter = 0;
function pi(type: string, rest: object, opts: PiOpts = {}) {
  const id = opts.id ?? `p${++piCounter}`;
  return { type, id, parentId: opts.parentId ?? null, timestamp: opts.timestamp ?? nextTs(), ...rest };
}

export function piSession(uuid: string, opts: PiOpts & { cwd?: string } = {}) {
  return { type: 'session', version: 3, id: uuid, timestamp: opts.timestamp ?? '2026-10-01T09:00:00Z', cwd: opts.cwd ?? '/work/app' };
}

export function piUser(text: string, opts: PiOpts = {}) {
  return pi('message', { message: { role: 'user', content: [{ type: 'text', text }], timestamp: 1 } }, opts);
}

/** An assistant message; `blocks` are pi content blocks (text, thinking, toolCall). */
export function piAssistant(blocks: object[], opts: PiOpts = {}) {
  return pi('message', { message: { role: 'assistant', content: blocks, timestamp: 1 } }, opts);
}

export const piText = (text: string) => ({ type: 'text', text });
export const piThinking = (thinking: string) => ({ type: 'thinking', thinking, thinkingSignature: 'sig' });
export const piToolCall = (id: string, name: string, args: object) => ({ type: 'toolCall', id, name, arguments: args });

export function piToolResult(toolCallId: string, toolName: string, text: string, opts: PiOpts & { isError?: boolean } = {}) {
  return pi('message', {
    message: { role: 'toolResult', toolCallId, toolName, isError: opts.isError ?? false, content: [{ type: 'text', text }], timestamp: 1 },
  }, opts);
}

export function piBashExecution(command: string, output: string, opts: PiOpts & { exitCode?: number; cancelled?: boolean } = {}) {
  return pi('message', {
    message: { role: 'bashExecution', command, output, exitCode: opts.exitCode ?? 0, cancelled: opts.cancelled ?? false, truncated: false, timestamp: 1, excludeFromContext: false },
  }, opts);
}

export function piMessage(role: string, text: string, opts: PiOpts = {}) {
  return pi('message', { message: { role, content: [{ type: 'text', text }], timestamp: 1 } }, opts);
}

export function piOther(type: string, rest: object = {}, opts: PiOpts = {}) {
  return pi(type, rest, opts);
}

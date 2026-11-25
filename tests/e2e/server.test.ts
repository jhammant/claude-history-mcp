import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  assistantText, codexLine, createCorpus, resetClock, toolResult, toolUse, userLine, type Corpus,
} from '../helpers/corpus.js';

const repo = resolve(__dirname, '../..');
const entry = join(repo, 'dist', 'index.js');
const version = (JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { version: string }).version;

async function connect(env: Record<string, string>, cwd: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd,
    env: { PATH: process.env.PATH ?? '', ...env },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'e2e', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  return (result.content as Array<{ type: string; text: string }>).map((c) => c.text).join('\n');
}

describe('built server over stdio', () => {
  let corpus: Corpus;
  let client: Client;

  beforeAll(async () => {
    execFileSync(process.execPath, [join(repo, 'node_modules', 'typescript', 'bin', 'tsc')], { cwd: repo, stdio: 'pipe' });
    corpus = createCorpus();
    resetClock('2026-11-01T09:00:00Z');
    const cwd = '/work/shop';
    corpus.write(corpus.sessionPath('-work-shop', '1b7e0c55-shop'), [
      userLine('The checkout fails with ECONNREFUSED 127.0.0.1:6379', { cwd }),
      toolUse('Bash', { command: 'docker compose ps redis' }, { cwd, id: 'm1' }),
      toolResult('redis   exited (137)', { cwd }),
      assistantText('Redis was killed by the OOM killer. I raised its memory limit; the issue was the 64m cap, fixed now.', { cwd }),
      userLine('We decided to use redis streams for the order queue', { cwd }),
    ]);
    corpus.write(corpus.subagentPath('-work-shop', '1b7e0c55-shop', 'f00d'), [
      userLine('Survey the queue consumers', { cwd, sessionId: '1b7e0c55-shop' }),
    ]);
    corpus.write(corpus.codexPath('-work-codex-api', 'codex-77'), [
      codexLine('user', 'Resolve backpressure in the bounded queue', { sessionId: 'codex-77', cwd: '/work/codex-api' }),
    ]);
    execFileSync(process.execPath, [entry, 'sweep'], { env: { ...process.env, ...corpus.env }, stdio: 'pipe' });
    client = await connect(corpus.env, corpus.root);
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    corpus?.cleanup();
  });

  it('reports the package version and the seven tools', async () => {
    expect(client.getServerVersion()).toMatchObject({ name: 'claude-history-mcp', version });
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(['find_patterns', 'find_solutions', 'get_project_context', 'get_session_summary',
      'list_projects', 'read_session', 'search_history']);
  });

  it('search_history finds a tool result and points at read_session', async () => {
    const text = await call(client, 'search_history', { query: 'exited 137', include_context: true });
    expect(text).toContain('session 1b7e0c55-shop · assistant #1 [Bash]');
    expect(text).toContain('**exited** (**137**)');
    expect(text).toContain('before #0 user: The checkout fails');
    expect(text).toContain('read_session');
  });

  it('search_history keeps filters and finds subagent and Codex sessions', async () => {
    expect(await call(client, 'search_history', { query: 'queue consumers' })).toContain('subagent of 1b7e0c55-shop');
    expect(await call(client, 'search_history', { query: 'backpressure source:codex' })).toContain('codex-77');
    expect(await call(client, 'search_history', { query: 'backpressure', project: 'shop' })).toContain('No matches');
  });

  it('read_session pages through the stored messages', async () => {
    const text = await call(client, 'read_session', { session_id: '1b7e0c55-shop', around: 1, limit: 3 });
    expect(text).toContain('#1 assistant');
    expect(text).toContain('▸ Bash: docker compose ps redis');
    expect(text).toContain('⇢ redis exited (137)');
  });

  it('find_solutions ranks the fix first and lists extracted fixes', async () => {
    const text = await call(client, 'find_solutions', { error_or_problem: 'ECONNREFUSED 6379', technology: 'redis' });
    expect(text).toContain('1b7e0c55-shop');
  });

  it('list_projects, get_session_summary, get_project_context and find_patterns answer from the database', async () => {
    const projects = await call(client, 'list_projects');
    expect(projects).toContain('- shop — 1 sessions, 5 messages (1 subagent runs)');
    expect(projects).toContain('codex-api');

    const summary = await call(client, 'get_session_summary', { project: 'shop' });
    expect(summary).toContain('**Session ID**: 1b7e0c55-shop');
    expect(summary).toContain('Bash');

    const context = await call(client, 'get_project_context', { project: 'shop', depth: 'detailed' });
    expect(context).toContain('## Project Context: /work/shop');
    expect(context).toContain('Decision: use redis streams for the order queue');

    const patterns = await call(client, 'find_patterns', { project: 'shop' });
    expect(patterns).toContain('## Patterns Found');
  });

  it('answers quickly with the command to run when there is no database yet', async () => {
    const empty = createCorpus();
    const bare = await connect({ ...empty.env, CLAUDE_HISTORY_DATA_DIR: join(empty.root, 'nothing-here') }, empty.root);
    try {
      const started = Date.now();
      const text = await call(bare, 'search_history', { query: 'anything' });
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(text).toContain('has not been built yet');
      expect(text).toMatch(/node .*index\.js sweep/);
    } finally {
      await bare.close();
      empty.cleanup();
    }
  });
});

import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { looseGroups, looseMatch, parseQuery, strictMatch } from '../../src/search/query-processor.js';

describe('parseQuery filters', () => {
  it('extracts a project filter', () => {
    const result = parseQuery('docker error project:ghostty');
    expect(result.text).toBe('docker error');
    expect(result.filters.project).toBe('ghostty');
  });

  it('extracts date filters, relative and ISO', () => {
    const before = Date.now();
    const result = parseQuery('fix after:7d before:2024-12-01');
    expect(result.text).toBe('fix');
    expect(result.filters.after).toBeGreaterThan(before - 7 * 86_400_000 - 1000);
    expect(result.filters.after).toBeLessThan(before - 7 * 86_400_000 + 1000);
    expect(result.filters.before).toBe(Date.parse('2024-12-01'));
  });

  it('extracts tool, branch, role, source and session filters', () => {
    const result = parseQuery('error tool:Bash branch:main role:assistant source:codex session:abc123');
    expect(result.text).toBe('error');
    expect(result.filters).toMatchObject({ tool: 'Bash', branch: 'main', role: 'assistant', source: 'codex', session: 'abc123' });
  });

  it('keeps a filter-looking word whose value is invalid as search text', () => {
    const result = parseQuery('role:admin source:svn after:someday');
    expect(result.filters).toEqual({});
    expect(result.groups.map((g) => g[0].parts)).toEqual([['role', 'admin'], ['source', 'svn'], ['after', 'someday']]);
  });

  it('accepts a quoted filter value with spaces', () => {
    expect(parseQuery('deploy project:"my app"').filters.project).toBe('my app');
  });

  it('handles no filters', () => {
    const result = parseQuery('simple search query');
    expect(result.text).toBe('simple search query');
    expect(result.filters).toEqual({});
  });
});

describe('FTS5 expressions', () => {
  it('quotes every term so FTS5 keywords typed by a user are plain words', () => {
    expect(strictMatch(parseQuery('near and not'))).toBe('"near" AND "and" AND "not"');
    expect(strictMatch(parseQuery('NOT NEAR'))).toBe('"not" AND "near"');
  });

  it('drops a typed AND and honours a typed OR between neighbouring terms', () => {
    expect(strictMatch(parseQuery('redis AND cache'))).toBe('"redis" AND "cache"');
    expect(strictMatch(parseQuery('deploy kubernetes OR nomad'))).toBe('"deploy" AND ("kubernetes" OR "nomad")');
    expect(strictMatch(parseQuery('OR leading'))).toBe('"leading"');
  });

  it('searches punctuated identifiers as phrases of their parts', () => {
    expect(strictMatch(parseQuery('index.msgpack'))).toBe('"index msgpack"');
    expect(strictMatch(parseQuery('ERR_SQLITE_ERROR'))).toBe('"err sqlite error"');
    expect(strictMatch(parseQuery('src/server.ts claude-history-mcp'))).toBe('"src server ts" AND "claude history mcp"');
  });

  it('treats quoted text as one phrase, even unterminated', () => {
    expect(strictMatch(parseQuery('"busy timeout" wal'))).toBe('"busy timeout" AND "wal"');
    expect(strictMatch(parseQuery('"never closed'))).toBe('"never closed"');
  });

  it('returns no expression for an empty or all-punctuation query', () => {
    expect(strictMatch(parseQuery(''))).toBeNull();
    expect(strictMatch(parseQuery('  *** ^^ () ""  '))).toBeNull();
    expect(looseMatch(parseQuery('project:app'))).toBeNull();
  });

  it('builds a loose query of any term with the last one as a prefix', () => {
    expect(looseMatch(parseQuery('sqlite busy timeo'))).toBe('"sqlite" OR "busy" OR "timeo"*');
    expect(looseGroups(parseQuery('a OR b c'))).toEqual(['("a" OR "b")', '"c"']);
  });

  it('never produces an FTS5 syntax error, whatever is typed', () => {
    const db = new Database(':memory:');
    db.exec("CREATE VIRTUAL TABLE t USING fts5(a, b, tokenize='porter unicode61 remove_diacritics 2')");
    db.prepare('INSERT INTO t VALUES (?, ?)').run('the sqlite busy timeout fired', 'npm test');
    const nasty = [
      'AND', 'OR', 'NOT', 'NEAR', 'NEAR(a b, 3)', 'a AND', 'OR OR OR', '"', '""', '"a" "b', '(a', 'a)', '*', 'a*', '^a',
      'a:b', 'col:value', '-a', '+a', 'a - b', '{a b}', "it's", 'C++', 'x = y || z', '100%', '$HOME/.config', 'ü ñ 日本語',
      'emoji 🚀 test', '\\', '\u0000', 'NOT a', 'a NOT b', 'a NEAR b', 'prose:foo', 'tool_input:bar', 'a OR', 'OR a',
    ];
    for (const raw of nasty) {
      const parsed = parseQuery(raw);
      for (const expr of [strictMatch(parsed), looseMatch(parsed), ...looseGroups(parsed)]) {
        if (expr === null) continue;
        expect(() => db.prepare('SELECT count(*) FROM t WHERE t MATCH ?').get(expr), `${raw} → ${expr}`).not.toThrow();
      }
    }
    db.close();
  });
});

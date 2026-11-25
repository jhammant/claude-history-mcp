import { afterEach, describe, expect, it } from 'vitest';
import { normaliseRemote, stripRemoteCredentials } from '../../src/repos/url.js';

const ALIASES = new Map([['git.int.example.com', 'git.example.com']]);

describe('stripRemoteCredentials', () => {
  it.each([
    ['https://user:tok@host/o/r.git', 'https://host/o/r.git'],
    ['https://tok@host/o/r', 'https://host/o/r'],
    ['https://u:p#ss@host/o/r', 'https://host/o/r'],
    ['ssh://git@host:2222/o/r', 'ssh://host:2222/o/r'],
    ['git@host:o/r.git', 'host:o/r.git'],
    ['https://host/o/r?token=x#f', 'https://host/o/r'],
    ['https://host/o/r', 'https://host/o/r'],
    ['~u:tok@host:o/r', 'host:o/r'],
  ])('%s -> %s', (input, expected) => {
    expect(stripRemoteCredentials(input)).toBe(expected);
  });
});

describe('credentials', () => {
  it('never keeps a token', () => {
    const s = stripRemoteCredentials('https://user:tok@example.com/acme/app.git?access_token=tok#frag');
    expect(s).toBe('https://example.com/acme/app.git');
    expect(normaliseRemote('https://user:tok@example.com/acme/app.git?access_token=tok')).toBe('example.com/acme/app');
  });
});

describe('normaliseRemote', () => {
  afterEach(() => { delete process.env.CLAUDE_HISTORY_REPO_HOST_ALIASES; });

  it('gives one key for the four URL forms, with the host alias applied and the case lowered', () => {
    for (const url of [
      'https://git.example.com/Acme/X.git',
      'ssh://git@git.int.example.com:2222/acme/x',
      'git@git.int.example.com:Acme/x.git',
      'git.int.example.com:acme/x',
    ]) {
      expect(normaliseRemote(url, ALIASES)).toBe('git.example.com/acme/x');
    }
  });

  it('drops credentials, port, query, fragment, trailing slash and .git', () => {
    expect(normaliseRemote('https://u:p@Host.Example:8443/Own/Repo.git/?a=b#c')).toBe('host.example/own/repo');
  });

  it('returns null when an @ sits in the path, so unrelated repositories never merge', () => {
    for (const bad of ['https://hostA/o/r@v2/extra/x', 'https://hostB/p/q@v2/extra/x', 'https://host/o/r@v2', 'host:o/a@b:c/d']) {
      expect(normaliseRemote(bad)).toBeNull();
    }
    expect(normaliseRemote('git@host:o/r.git')).toBe('host/o/r');
    expect(normaliseRemote('https://user:tok@host/o/r.git')).toBe('host/o/r');
  });

  it('returns null for Windows drive paths and single-letter hosts', () => {
    for (const bad of ['C:/Users/x', 'C:\\x', 'c:/a/b']) expect(normaliseRemote(bad)).toBeNull();
  });

  it('keeps a deeper path whole', () => {
    expect(normaliseRemote('https://host/group/sub/name.git')).toBe('host/group/sub/name');
  });

  it('returns null for local paths, file URLs and anything unparseable', () => {
    for (const bad of ['not a url', '/home/me/repo', './repo', '../repo', 'file:///srv/git/x.git', 'C:\\src\\x', '', 'https://host/onlyone', 'https://host']) {
      expect(normaliseRemote(bad)).toBeNull();
    }
  });

  it('reads aliases from the environment by default, ignoring malformed entries', () => {
    process.env.CLAUDE_HISTORY_REPO_HOST_ALIASES = 'bad, A.Example = b.example ,=x,y=,c.example=d.example';
    expect(normaliseRemote('https://a.example/o/r')).toBe('b.example/o/r');
    expect(normaliseRemote('https://c.example/o/r')).toBe('d.example/o/r');
    expect(normaliseRemote('https://bad/o/r')).toBe('bad/o/r');
  });
});

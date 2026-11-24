import { spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCommand } from "../../src/cli/commands.js";
import { probeRepo, recordRepos } from "../../src/repos/probe.js";

const hasGit = spawnSync("git", ["--version"]).status === 0;

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    env: GIT_ENV,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

describe.skipIf(!hasGit)("git probe", () => {
  let tmp: string;
  let repo: string;
  let mapDir: string;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "probe-")));
    repo = join(tmp, "repo");
    mkdirSync(join(repo, "src"), { recursive: true });
    git(repo, "init", "-q");
    writeFileSync(join(repo, "a.txt"), "a");
    git(repo, "add", "a.txt");
    git(repo, "commit", "-q", "-m", "init");
    mapDir = join(tmp, "map");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("reports a plain repository with its origin, credentials stripped", () => {
    git(repo, "remote", "add", "origin", "https://user:tok@example.com/acme/app.git");
    expect(probeRepo(join(repo, "src"))).toEqual([{ dir: repo, root: repo, remote: "https://example.com/acme/app.git" }]);
  });

  it("reports a linked worktree with its main repository as root", () => {
    git(repo, "remote", "add", "origin", "https://example.com/acme/app.git");
    const wt = join(tmp, "wt");
    git(repo, "worktree", "add", "-q", wt);
    expect(probeRepo(wt)).toEqual([{ dir: wt, root: repo, remote: "https://example.com/acme/app.git" }]);
  });

  it("reports a repository with no origin with remote null", () => {
    expect(probeRepo(repo)).toEqual([{ dir: repo, root: repo, remote: null }]);
  });

  it("adds the logical top when the directory is reached through a symlink", () => {
    const link = join(tmp, "link");
    symlinkSync(repo, link);
    expect(probeRepo(join(link, "src"))).toEqual([
      { dir: repo, root: repo, remote: null },
      { dir: link, root: repo, remote: null },
    ]);
  });

  it("returns nothing for a plain directory, a missing directory, or when git is not on PATH", () => {
    const plain = join(tmp, "plain");
    mkdirSync(plain);
    expect(probeRepo(plain)).toEqual([]);
    expect(probeRepo(join(tmp, "missing"))).toEqual([]);
    const empty = join(tmp, "empty");
    mkdirSync(empty);
    const savedPath = process.env.PATH;
    try {
      process.env.PATH = empty;
      expect(probeRepo(repo)).toEqual([]);
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it("appends a line once", () => {
    git(repo, "remote", "add", "origin", "https://user:tok@example.com/acme/app.git");
    expect(recordRepos([repo], { mapDir, host: "laptop", now: 1_800_000_000 })).toBe(1);
    expect(recordRepos([repo], { mapDir, host: "laptop", now: 1_800_000_500 })).toBe(0);
    const file = join(mapDir, "laptop.jsonl");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(mapDir).mode & 0o777).toBe(0o700);
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain("tok");
    expect(JSON.parse(text.trim())).toEqual({ dir: repo, root: repo, remote: "https://example.com/acme/app.git", at: 1_800_000_000 });
  });

  it("ignores a corrupt line already in the file", () => {
    mkdirSync(mapDir, { recursive: true });
    const file = join(mapDir, "laptop.jsonl");
    writeFileSync(file, "not json\n{\"dir\":1}\n");
    expect(recordRepos([repo], { mapDir, host: "laptop", now: 1_800_000_000 })).toBe(1);
    expect(recordRepos([repo], { mapDir, host: "laptop", now: 1_800_000_000 })).toBe(0);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[2]).dir).toBe(repo);
  });

  it("writes nothing when no directory is a repository", () => {
    const plain = join(tmp, "plain");
    mkdirSync(plain);
    expect(recordRepos([plain, join(tmp, "missing")], { mapDir, host: "laptop" })).toBe(0);
    expect(existsSync(mapDir)).toBe(false);
  });

  it("record-repo prints nothing and exits 0 outside a repository", async () => {
    const plain = join(tmp, "plain");
    mkdirSync(plain);
    const saved = { dir: process.env.CLAUDE_HISTORY_DATA_DIR, host: process.env.CLAUDE_HISTORY_HOST };
    process.env.CLAUDE_HISTORY_DATA_DIR = join(tmp, "data");
    process.env.CLAUDE_HISTORY_HOST = "laptop";
    const out: unknown[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...a: unknown[]) => void out.push(a);
    console.error = (...a: unknown[]) => void out.push(a);
    try {
      expect(await runCommand("record-repo", [plain])).toBe(0);
    } finally {
      console.log = origLog;
      console.error = origErr;
      for (const [k, v] of [["CLAUDE_HISTORY_DATA_DIR", saved.dir], ["CLAUDE_HISTORY_HOST", saved.host]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    expect(out).toEqual([]);
    expect(existsSync(join(tmp, "data"))).toBe(false);
  });
});

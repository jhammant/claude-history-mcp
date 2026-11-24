/**
 * The directory-to-repository map pushed by client machines. Each machine writes a small
 * JSON-lines file into the meta directory; one line records, for a work-tree directory,
 * its main repository root and origin URL. The files are untrusted input.
 */

import { lstatSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import type { DB } from "../db/database.js";
import { normaliseRemote, stripRemoteCredentials } from "./url.js";

/** A map file larger than this is skipped (they are a few KB in practice). */
const MAX_MAP_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 500;
const MAX_ENTRIES_PER_FILE = 50_000;
/** An `at` further in the future than this is invalid: it must not pin a directory forever. */
const MAX_FUTURE_SECONDS = 24 * 60 * 60;

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.error(`claude-history: ${message}`);
}

interface Entry {
  dir: string;
  root: string;
  remote: string | null;
  at: number;
}

/** An absolute path without `..` segments or NULs, minus trailing slashes; else null. */
function cleanPath(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("\0")) return null;
  if (value.split("/").includes("..")) return null;
  const trimmed = value.replace(/\/+$/, "");
  return trimmed || null;
}

function parseLine(text: string, nowSeconds: number): Entry | null {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  const dir = cleanPath(o.dir);
  const root = cleanPath(o.root);
  if (!dir || !root) return null;
  if (typeof o.at !== "number" || !Number.isFinite(o.at) || o.at < 0 || o.at > nowSeconds + MAX_FUTURE_SECONDS) return null;
  let remote: string | null = null;
  if (typeof o.remote === "string") {
    const stripped = stripRemoteCredentials(o.remote);
    remote = normaliseRemote(stripped, new Map()) ? stripped : null;
  }
  return { dir, root, remote, at: Math.floor(o.at) };
}

/** Regular `*.jsonl` files (symlinks are not followed), at most MAX_FILES. */
function listJsonl(dir: string, out: string[], depth = 0): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory() && depth < 4) listJsonl(full, out, depth + 1);
    else if (e.isFile() && e.name.endsWith(".jsonl")) {
      if (out.length >= MAX_FILES) {
        warnOnce("files", `repo map: more than ${MAX_FILES} files, the rest are ignored`);
        return;
      }
      out.push(full);
    }
  }
}

/** `<mapDir>/<file>` when it is a regular file (a symlink is not followed), else nothing. */
function namedFile(mapDir: string, file: string, out: string[]): void {
  const full = join(mapDir, file);
  try {
    if (lstatSync(full).isFile()) out.push(full);
  } catch {
    // missing
  }
}

/**
 * Read the map files in mapDir, store each entry under `host`, and upsert entries with a newer
 * `at`. `changed` is true when a row was written. By default every `*.jsonl` file below mapDir is
 * read (a directory that holds one host's files); `options.file` reads that one file only, as
 * the local sweep does with `<host>.jsonl`, so another host's file in a shared directory never
 * applies to this host.
 */
export function loadRepoMaps(
  db: DB, mapDir: string, host: string, options: { file?: string } = {},
): { files: number; entries: number; changed: boolean } {
  const paths: string[] = [];
  if (options.file !== undefined) namedFile(mapDir, options.file, paths);
  else listJsonl(mapDir, paths);
  paths.sort();
  const nowSeconds = Date.now() / 1000;
  const newest = new Map<string, Entry>();
  let files = 0;
  let entries = 0;
  for (const path of paths) {
    let text: string;
    try {
      if (statSync(path).size > MAX_MAP_BYTES) {
        warnOnce(path, `repo map file ${path} is over ${MAX_MAP_BYTES} bytes and is skipped`);
        continue;
      }
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    files++;
    let seen = 0;
    for (const raw of text.split("\n")) {
      if (!raw.trim()) continue;
      if (++seen > MAX_ENTRIES_PER_FILE) {
        warnOnce(`entries:${path}`, `repo map file ${path} has more than ${MAX_ENTRIES_PER_FILE} lines, the rest are ignored`);
        break;
      }
      const entry = parseLine(raw, nowSeconds);
      if (!entry) continue;
      entries++;
      const prior = newest.get(entry.dir);
      if (!prior || entry.at > prior.at) newest.set(entry.dir, entry);
    }
  }
  if (newest.size === 0) return { files, entries, changed: false };
  const upsert = db.prepare(
    `INSERT INTO repo_map(host, dir, root, remote, at) VALUES (@host, @dir, @root, @remote, @at)
     ON CONFLICT(host, dir) DO UPDATE SET root = excluded.root, remote = excluded.remote, at = excluded.at
     WHERE excluded.at > repo_map.at`
  );
  const changes = db.transaction(() => {
    let n = 0;
    for (const entry of newest.values()) n += upsert.run({ ...entry, host }).changes;
    return n;
  }).immediate();
  return { files, entries, changed: changes > 0 };
}

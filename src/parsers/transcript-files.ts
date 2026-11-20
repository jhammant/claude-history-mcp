/**
 * Find transcript files on disk.
 *
 *   <claude projects>/<project>/<session>.jsonl                          a session
 *   <claude projects>/<project>/<session>/subagents/**\/agent-<id>.jsonl  its subagents
 *
 * A subagent's session id is agent-<id>@<parent session id>: the same agent file name
 * can appear under two parents (a forked session copies them), and must not merge.
 *   <codex feed>/projects/<project>/codex-<id>.jsonl                      a Codex session
 */

import { readdirSync, statSync, type Dirent } from "fs";
import { basename, dirname, join } from "path";
import { CONFIG } from "../config.js";

export type Source = "claude" | "codex";

export interface TranscriptFile {
  path: string;
  source: Source;
  /** Encoded project directory name, e.g. -work-app. */
  projectDir: string;
  sessionId: string;
  isSubagent: boolean;
  parentSessionId?: string;
  size: number;
  mtimeMs: number;
  ino: number;
}

export interface ListOptions {
  /**
   * Which sessions' subagent directories to walk. Walking all of them costs a few
   * hundred ms on a large history; a caller in a hurry passes a filter.
   */
  includeSubagentsOf?: (parentSessionId: string) => boolean;
}

export function transcriptRoots(): Array<{ dir: string; source: Source }> {
  return [
    { dir: CONFIG.projectsDir, source: "claude" },
    { dir: CONFIG.codexProjectsDir, source: "codex" },
  ];
}

function readDir(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function statFile(
  path: string,
  base: Omit<TranscriptFile, "path" | "size" | "mtimeMs" | "ino">
): TranscriptFile | null {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return null;
    return { ...base, path, size: stat.size, mtimeMs: Math.floor(stat.mtimeMs), ino: stat.ino };
  } catch {
    return null; // deleted between readdir and stat
  }
}

/** Stored id of a subagent: its file name stem, qualified by the parent session. */
export function subagentSessionId(agentStem: string, parentSessionId: string): string {
  return `${agentStem}@${parentSessionId}`;
}

function collectSubagents(
  dir: string,
  projectDir: string,
  parentSessionId: string,
  out: TranscriptFile[]
): void {
  for (const entry of readDir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSubagents(path, projectDir, parentSessionId, out);
    } else if (entry.name.startsWith("agent-") && entry.name.endsWith(".jsonl")) {
      const file = statFile(path, {
        source: "claude",
        projectDir,
        sessionId: subagentSessionId(basename(entry.name, ".jsonl"), parentSessionId),
        isSubagent: true,
        parentSessionId,
      });
      if (file) out.push(file);
    }
  }
}

export function listTranscripts(options: ListOptions = {}): TranscriptFile[] {
  const includeSubagents = options.includeSubagentsOf ?? (() => true);
  const out: TranscriptFile[] = [];
  for (const root of transcriptRoots()) {
    for (const project of readDir(root.dir)) {
      if (!project.isDirectory()) continue;
      const projectPath = join(root.dir, project.name);
      for (const entry of readDir(projectPath)) {
        const path = join(projectPath, entry.name);
        if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          const file = statFile(path, {
            source: root.source,
            projectDir: project.name,
            sessionId: basename(entry.name, ".jsonl"),
            isSubagent: false,
          });
          if (file) out.push(file);
        } else if (entry.isDirectory() && root.source === "claude" && includeSubagents(entry.name)) {
          collectSubagents(join(path, "subagents"), project.name, entry.name, out);
        }
      }
    }
  }
  return out;
}

/** Subagent transcripts of one top-level Claude session file. */
export function listSubagentFiles(parent: TranscriptFile): TranscriptFile[] {
  if (parent.source !== "claude" || parent.isSubagent) return [];
  const out: TranscriptFile[] = [];
  collectSubagents(join(dirname(parent.path), parent.sessionId, "subagents"), parent.projectDir, parent.sessionId, out);
  return out;
}

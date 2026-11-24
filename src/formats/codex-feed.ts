/**
 *   <codex feed>/projects/<project>/codex-<id>.jsonl                      a Codex session
 *
 * The feed already writes Claude-shaped lines, so translation is the identity.
 */

import { basename, join } from "path";
import { CONFIG } from "../config.js";
import type { TranscriptFile } from "../parsers/transcript-files.js";
import { isClaudeShapedMessage } from "./claude.js";
import { readDir, statFile } from "./fs-util.js";
import type { TranscriptFormat } from "./types.js";

export const codexFeedFormat: TranscriptFormat = {
  id: "codex-feed",
  source: "codex",
  root: () => CONFIG.codexProjectsDir,
  projectFromContent: false,
  list(root: string): TranscriptFile[] {
    const out: TranscriptFile[] = [];
    for (const project of readDir(root)) {
      if (!project.isDirectory()) continue;
      const projectPath = join(root, project.name);
      for (const entry of readDir(projectPath)) {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        const file = statFile(join(projectPath, entry.name), {
          source: "codex",
          format: "codex-feed",
          projectDir: project.name,
          sessionId: basename(entry.name, ".jsonl"),
          isSubagent: false,
        });
        if (file) out.push(file);
      }
    }
    return out;
  },
  isMessageLine: isClaudeShapedMessage,
  translator: () => ({ translate: (obj) => [obj] }),
};

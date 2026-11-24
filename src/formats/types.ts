import type { ListOptions, TranscriptFile } from "../parsers/transcript-files.js";

export type Source = "claude" | "codex" | "pi";
/** Every source, in display order: the one list the query filter, counts and report derive from. */
export const SOURCES: readonly Source[] = ["claude", "codex", "pi"];
/** How a source is written in prose: "Claude sessions", "Codex sessions", "pi sessions". */
export const SOURCE_LABELS: Record<Source, string> = { claude: "Claude", codex: "Codex", pi: "pi" };
export type FormatId = "claude" | "codex-feed" | "codex-rollout" | "pi";
/** A line in Claude Code's transcript shape, as RowBuilder.addLine reads it. */
export type ClaudeLine = Record<string, unknown>;

export interface LineTranslator {
  /** Zero or more Claude-shaped lines for one parsed native line; `at` is the line's byte offset in the file. */
  translate(obj: Record<string, unknown>, at?: number): ClaudeLine[];
}

export interface TranscriptFormat {
  id: FormatId;
  source: Source;
  root(): string;
  /** True when the project comes from file content (cwd), not from the path. */
  projectFromContent: boolean;
  list(root: string, options: ListOptions): TranscriptFile[];
  /**
   * True when a file of this format must not take over a session id that another file
   * already owns (the first indexed keeps it; this one is skipped with one log line).
   */
  firstFileWins?: boolean;
  /** Cheap check on the raw bytes of a line of at least BIG_LINE bytes. */
  isMessageLine(head: string): boolean;
  /** One per file read; `resumed` is true when reading starts past offset 0. */
  translator(file: TranscriptFile, resumed: boolean): LineTranslator;
}

/**
 * Find transcript files on disk: each registered format (src/formats) walks its own root.
 */
import { subagentSessionId } from "../formats/claude.js";
import type { FormatId, Source } from "../formats/types.js";
export type { Source } from "../formats/types.js";
export { subagentSessionId };
export interface TranscriptFile {
    path: string;
    source: Source;
    format: FormatId;
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
export declare function listTranscripts(options?: ListOptions): TranscriptFile[];
/** Subagent transcripts of one top-level Claude session file. */
export declare function listSubagentFiles(parent: TranscriptFile): TranscriptFile[];
//# sourceMappingURL=transcript-files.d.ts.map
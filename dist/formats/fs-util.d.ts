import { type Dirent } from "fs";
import type { TranscriptFile } from "../parsers/transcript-files.js";
export declare function readDir(dir: string): Dirent[];
export declare function statFile(path: string, base: Omit<TranscriptFile, "path" | "size" | "mtimeMs" | "ino">): TranscriptFile | null;
/** The first line of a file, up to a cap (a session_meta with its base instructions is large). */
export declare function readFirstLine(path: string): string | null;
/**
 * The first `count` lines of a file, each read with readFirstLine's cap: a line whose
 * newline is not found within FIRST_LINE_MAX bytes (plus the chunk that crosses it) ends
 * the list, and it and the lines after it are left out. A last line with no newline yet is
 * included.
 */
export declare function readHeadLines(path: string, count: number): string[];
//# sourceMappingURL=fs-util.d.ts.map
import { type Dirent } from "fs";
import type { TranscriptFile } from "../parsers/transcript-files.js";
export declare function readDir(dir: string): Dirent[];
export declare function statFile(path: string, base: Omit<TranscriptFile, "path" | "size" | "mtimeMs" | "ino">): TranscriptFile | null;
/** The first line of a file, up to a cap (a session_meta with its base instructions is large). */
export declare function readFirstLine(path: string): string | null;
//# sourceMappingURL=fs-util.d.ts.map
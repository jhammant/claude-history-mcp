/**
 * Claude Code encodes project paths by replacing '/' with '-'.
 * e.g., /Users/jon/dev/ghostty -> -Users-jon-dev-ghostty
 */
export declare function encodeProjectPath(absolutePath: string): string;
/** Project directory for a session whose path does not say; filled in from its cwd. */
export declare const UNKNOWN_PROJECT = "-unknown";
/**
 * The directory name Claude Code gives a working directory: every character outside
 * [A-Za-z0-9] becomes '-', so /home/me/.claude is -home-me--claude. A trailing
 * slash is ignored.
 */
export declare function claudeProjectDir(cwd: string): string;
export declare function decodeProjectPath(encoded: string): string;
/**
 * Extract a short project name from an encoded path.
 * e.g., -Users-jon-dev-ghostty -> ghostty
 *       -Users-jon-dev-ESTAR-Zolo -> ESTAR-Zolo
 */
export declare function extractProjectName(encodedOrPath: string): string;
//# sourceMappingURL=path-encoder.d.ts.map
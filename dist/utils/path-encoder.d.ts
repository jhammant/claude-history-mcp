/**
 * Claude Code encodes project paths by replacing '/' with '-'.
 * e.g., /Users/jon/dev/ghostty -> -Users-jon-dev-ghostty
 */
export declare function encodeProjectPath(absolutePath: string): string;
export declare function decodeProjectPath(encoded: string): string;
/**
 * Extract a short project name from an encoded path.
 * e.g., -Users-jon-dev-ghostty -> ghostty
 *       -Users-jon-dev-ESTAR-Zolo -> ESTAR-Zolo
 */
export declare function extractProjectName(encodedOrPath: string): string;
/**
 * Find which encoded project directory matches a given working directory.
 */
export declare function matchProjectDir(cwd: string, projectDirs: string[]): string | null;
//# sourceMappingURL=path-encoder.d.ts.map
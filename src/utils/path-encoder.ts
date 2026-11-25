/**
 * Claude Code encodes project paths by replacing '/' with '-'.
 * e.g., /Users/jon/dev/ghostty -> -Users-jon-dev-ghostty
 */

export function encodeProjectPath(absolutePath: string): string {
  return absolutePath.replace(/\//g, "-");
}

/** Project directory for a session whose path does not say; filled in from its cwd. */
export const UNKNOWN_PROJECT = "-unknown";

/**
 * The directory name Claude Code gives a working directory: every character outside
 * [A-Za-z0-9] becomes '-', so /home/me/.claude is -home-me--claude. A trailing
 * slash is ignored.
 */
export function claudeProjectDir(cwd: string): string {
  return cwd.replace(/\/+$/, "").replace(/[^A-Za-z0-9]/g, "-");
}

export function decodeProjectPath(encoded: string): string {
  // First char is always '-' which maps to leading '/'
  return encoded.replace(/-/g, "/");
}

/**
 * Extract a short project name from an encoded path.
 * e.g., -Users-jon-dev-ghostty -> ghostty
 *       -Users-jon-dev-ESTAR-Zolo -> ESTAR-Zolo
 */
export function extractProjectName(encodedOrPath: string): string {
  const decoded = encodedOrPath.startsWith("-")
    ? decodeProjectPath(encodedOrPath)
    : encodedOrPath;
  const parts = decoded.split("/").filter(Boolean);
  return parts[parts.length - 1] || decoded;
}

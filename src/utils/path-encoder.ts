/**
 * Claude Code encodes project paths by replacing '/' with '-'.
 * e.g., /Users/jon/dev/ghostty -> -Users-jon-dev-ghostty
 */

export function encodeProjectPath(absolutePath: string): string {
  return absolutePath.replace(/\//g, "-");
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

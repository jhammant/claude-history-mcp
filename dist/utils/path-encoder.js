/**
 * Claude Code encodes project paths by replacing '/' with '-'.
 * e.g., /Users/jon/dev/ghostty -> -Users-jon-dev-ghostty
 */
export function encodeProjectPath(absolutePath) {
    return absolutePath.replace(/\//g, "-");
}
export function decodeProjectPath(encoded) {
    // First char is always '-' which maps to leading '/'
    return encoded.replace(/-/g, "/");
}
/**
 * Extract a short project name from an encoded path.
 * e.g., -Users-jon-dev-ghostty -> ghostty
 *       -Users-jon-dev-ESTAR-Zolo -> ESTAR-Zolo
 */
export function extractProjectName(encodedOrPath) {
    const decoded = encodedOrPath.startsWith("-")
        ? decodeProjectPath(encodedOrPath)
        : encodedOrPath;
    const parts = decoded.split("/").filter(Boolean);
    return parts[parts.length - 1] || decoded;
}
//# sourceMappingURL=path-encoder.js.map
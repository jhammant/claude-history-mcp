/**
 * Find transcript files on disk: each registered format (src/formats) walks its own root.
 */
import { dirname, join } from "path";
import { collectSubagents, subagentSessionId } from "../formats/claude.js";
import { FORMATS } from "../formats/registry.js";
export { subagentSessionId };
export function listTranscripts(options = {}) {
    return FORMATS.flatMap((f) => f.list(f.root(), options));
}
/** Subagent transcripts of one top-level Claude session file. */
export function listSubagentFiles(parent) {
    if (parent.source !== "claude" || parent.isSubagent)
        return [];
    const out = [];
    collectSubagents(join(dirname(parent.path), parent.sessionId, "subagents"), parent.projectDir, parent.sessionId, out);
    return out;
}
//# sourceMappingURL=transcript-files.js.map
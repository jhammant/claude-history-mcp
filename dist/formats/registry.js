import { claudeFormat } from "./claude.js";
import { codexFeedFormat } from "./codex-feed.js";
import { codexRolloutFormat } from "./codex-rollout.js";
import { piFormat } from "./pi.js";
/** Every transcript format, in listing order. A new format is one module plus a line here. */
export const FORMATS = [claudeFormat, codexFeedFormat, codexRolloutFormat, piFormat];
export function formatOf(id) {
    const format = FORMATS.find((f) => f.id === id);
    if (!format)
        throw new Error(`unknown transcript format: ${id}`);
    return format;
}
//# sourceMappingURL=registry.js.map
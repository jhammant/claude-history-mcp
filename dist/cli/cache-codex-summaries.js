/** Refresh local Codex startup summaries without loading or replacing the index. */
import { existsSync, statSync } from 'fs';
import { join } from 'path';
import { CONFIG } from '../config.js';
import { enumerateSessionFiles, parseSessionFile } from '../parsers/session-parser.js';
import { cacheSummary, summarizeSession } from '../knowledge/session-summarizer.js';
let updated = 0;
for (const file of enumerateSessionFiles()) {
    if (!file.sessionId.startsWith('codex-'))
        continue;
    const target = join(CONFIG.summariesDir, file.sessionId + '.json');
    if (existsSync(target) && statSync(target).mtimeMs >= file.mtime)
        continue;
    const session = parseSessionFile(file.filePath, file.projectDir);
    if (!session)
        continue;
    cacheSummary(summarizeSession(session));
    updated++;
}
console.log(JSON.stringify({ updated }));
//# sourceMappingURL=cache-codex-summaries.js.map
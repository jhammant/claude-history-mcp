import type { DB } from "../db/database.js";
import type { SearchEngine } from "../search/search-engine.js";
export declare function handleFindSolutions(db: DB, engine: SearchEngine, args: {
    error_or_problem: string;
    technology?: string;
}, context?: {
    currentProject?: string;
    freshness?: string;
}): string;
//# sourceMappingURL=find-solutions.d.ts.map
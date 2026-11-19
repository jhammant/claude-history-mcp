import { formatSearchResponse } from "../search/format.js";
export function handleSearchHistory(engine, args, context = {}) {
    const response = engine.search(args.query ?? "", {
        limit: args.limit,
        project: args.project,
        includeContext: args.include_context,
        sort: args.sort,
        currentProject: context.currentProject,
    });
    return formatSearchResponse(response, args.query ?? "", context.freshness);
}
//# sourceMappingURL=search-history.js.map
import type { SearchEngine, SortOrder } from "../search/search-engine.js";
import { formatSearchResponse } from "../search/format.js";

export interface SearchHistoryArgs {
  query: string;
  project?: string;
  limit?: number;
  include_context?: boolean;
  sort?: SortOrder;
}

export function handleSearchHistory(
  engine: SearchEngine,
  args: SearchHistoryArgs,
  context: { currentProject?: string; freshness?: string } = {}
): string {
  const response = engine.search(args.query ?? "", {
    limit: args.limit,
    project: args.project,
    includeContext: args.include_context,
    sort: args.sort,
    currentProject: context.currentProject,
  });
  return formatSearchResponse(response, args.query ?? "", context.freshness);
}

/**
 * Parse query syntax: extract filters and clean query text.
 * Supports: project:name, before:date, after:date, tool:name, branch:name
 */

export interface ParsedQuery {
  text: string; // Clean query text without filter directives
  filters: QueryFilters;
}

export interface QueryFilters {
  project?: string;
  before?: number; // timestamp
  after?: number; // timestamp
  tool?: string;
  branch?: string;
}

const FILTER_PATTERN =
  /\b(project|before|after|tool|branch):(\S+)/gi;

export function parseQuery(rawQuery: string): ParsedQuery {
  const filters: QueryFilters = {};
  let text = rawQuery;

  // Extract filter directives
  const matches = [...rawQuery.matchAll(FILTER_PATTERN)];
  for (const match of matches) {
    const key = match[1].toLowerCase();
    const value = match[2];

    switch (key) {
      case "project":
        filters.project = value;
        break;
      case "before":
        filters.before = parseDate(value);
        break;
      case "after":
        filters.after = parseDate(value);
        break;
      case "tool":
        filters.tool = value;
        break;
      case "branch":
        filters.branch = value;
        break;
    }

    // Remove filter from text
    text = text.replace(match[0], "");
  }

  return {
    text: text.replace(/\s+/g, " ").trim(),
    filters,
  };
}

function parseDate(value: string): number {
  // Support relative dates: 7d, 30d, 1w, 1m, 1y
  const relMatch = value.match(/^(\d+)([dwmy])$/);
  if (relMatch) {
    const amount = parseInt(relMatch[1], 10);
    const unit = relMatch[2];
    const now = Date.now();
    const ms: Record<string, number> = {
      d: 86400000,
      w: 604800000,
      m: 2592000000,
      y: 31536000000,
    };
    return now - amount * (ms[unit] || 0);
  }

  // Support ISO dates: 2024-01-15
  const ts = new Date(value).getTime();
  return isNaN(ts) ? 0 : ts;
}

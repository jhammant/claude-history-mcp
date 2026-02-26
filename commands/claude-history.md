# Claude History Search

Search and recall context from past Claude Code conversations.

## Usage

```bash
/claude-history <query>              # General search
/claude-history --solutions <error>  # Find past error fixes
/claude-history --summary            # Summarize last session for current project
/claude-history --patterns           # Discover recurring patterns
/claude-history --context            # Get full project context
/claude-history --projects           # List all projects with history
```

## Your Task

Parse the user's arguments and use the appropriate MCP tool from `claude-history-mcp`:

1. **If `--solutions` flag**: Use `find_solutions` tool with the remaining text as `error_or_problem`
2. **If `--summary` flag**: Use `get_session_summary` tool with the current project
3. **If `--patterns` flag**: Use `find_patterns` tool, optionally scoped to current project
4. **If `--context` flag**: Use `get_project_context` tool with current project
5. **If `--projects` flag**: Use `list_projects` tool
6. **Otherwise**: Use `search_history` tool with the full text as the query

## Presentation

Present results clearly:
- For search results: show project, date, and relevant excerpt
- For solutions: highlight the error → fix pattern
- For summaries: use structured format with sections
- For patterns: group by pattern type

If no results are found, suggest alternative search terms or broader queries.

## Examples

```bash
# Search for Docker networking discussions
/claude-history docker network configuration

# Find how you fixed a specific error before
/claude-history --solutions ECONNREFUSED port 3000

# Get a summary of the last coding session
/claude-history --summary

# Find patterns in your React project
/claude-history --patterns project:react-app

# Search with date filter
/claude-history authentication after:7d
```

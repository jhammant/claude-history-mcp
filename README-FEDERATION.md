# Federated Learning — Community Knowledge Sharing

## The 3 Privacy Layers

ClaudeHistoryMCP uses a layered privacy model to let you benefit from community knowledge while keeping your data safe:

### Layer 1: PRIVATE (local only)
Your full conversation history, code snippets, file paths, and secrets **never leave your machine**. This is the default — the existing MCP server works entirely locally.

### Layer 2: TEAM (encrypted, within your org)
End-to-end encrypted knowledge sharing within your team. Only team members with the decryption key can access shared entries.

### Layer 3: COMMUNITY (federated, anonymous)
**Opt-in** sharing of anonymised, generalised patterns with the global developer community. This is what the federation layer provides.

## What Gets Shared (Layer 3)

When you opt in, the federation layer extracts **generalised patterns** from your local knowledge:

| Shared | Never Shared |
|--------|-------------|
| Error type → fix approach | Source code |
| Technology categories & tags | File paths |
| Generalised solution descriptions | Variable/function/class names |
| Effectiveness scores | Project/company/person names |
| Contributor counts | Specific values, secrets, credentials |
| | Stack traces, import paths |
| | Anything seen in fewer than 3 sessions |

### Privacy Guarantees

- **K-anonymity**: Patterns are only contributed after being observed in 3+ independent local sessions
- **Identifier stripping**: All file paths, names, URLs, IPs, secrets, and specific values are stripped
- **Error generalisation**: Error messages keep only the error type; stack traces and file references are removed
- **Value replacement**: Specific values become categories (e.g. "port 3000" → "custom port")
- **Hashed identifiers**: Any remaining identifiers are SHA-256 hashed with a salt
- **No code**: Approach descriptions are natural language only — no code snippets

## How to Opt In

```bash
# Enable federation
claude-history-mcp federation enable

# Check status
claude-history-mcp federation status

# Manually push patterns
claude-history-mcp federation contribute

# Pull community patterns
claude-history-mcp federation pull
```

Or set the environment variable:
```bash
export CLAUDE_HISTORY_FEDERATION_ENABLED=true
```

## Using Community Knowledge

Once enabled, a new MCP tool becomes available:

### `search_community_knowledge`

Search the federated community hub for patterns matching your problem:

```
> search_community_knowledge("nextjs hydration mismatch")

[solution] frameworks/nextjs — Hydration mismatches from date/time rendering can be resolved
by deferring dynamic content to useEffect or using suppressHydrationWarning for
non-critical elements.
  👥 47 contributors | ⭐ 89% effective

[error_fix] frameworks/react — Component rendering different content on server vs client
typically caused by browser-only APIs. Wrap in dynamic() with ssr:false or use
client-side detection.
  👥 23 contributors | ⭐ 76% effective
```

## Architecture

```
Your Machine                    Community Hub
┌─────────────────────┐         ┌──────────────────┐
│ Local Knowledge DB  │         │ PostgreSQL        │
│ (full history)      │         │ (anonymous only)  │
│         │           │         │                   │
│    Privacy Filter   │ ──────► │ Contribute API    │
│    • Strip IDs      │         │ • Validate        │
│    • Generalise     │         │ • Deduplicate     │
│    • K-anonymity    │         │ • Merge           │
│    • Hash           │         │                   │
│         │           │         │                   │
│    Federation       │ ◄────── │ Search API        │
│    Client           │         │ • Full-text       │
│         │           │         │ • Filter by tech  │
│    MCP Tool:        │         │ • K-anonymity     │
│    search_community │         │   gate (≥3)       │
└─────────────────────┘         └──────────────────┘
```

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `CLAUDE_HISTORY_FEDERATION_ENABLED` | `false` | Enable federation (opt-in) |
| `CLAUDE_HISTORY_FEDERATION_URL` | `https://api.claude-history.dev/api/federation` | Hub URL |
| `CLAUDE_HISTORY_FEDERATION_SALT` | (built-in) | Salt for anonymous hashing |

## Community Benefit

The more developers opt in, the more valuable the community knowledge becomes. Patterns gain confidence as more independent contributors report them. High-effectiveness patterns surface first in search results.

Think of it as Stack Overflow distilled into searchable, ranked patterns — built automatically from real developer experiences, with privacy baked in from the start.

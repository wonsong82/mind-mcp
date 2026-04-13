# mind-mcp

Persistent memory for AI coding agents. Structured knowledge that survives across sessions — decisions, discoveries, conventions, resolved issues, and anything worth remembering.

No vector DB. No embeddings. No external services. Just files + your LLM's semantic understanding.

## Installation

Give your AI agent one of these prompts. It will read the guide and set everything up.

### Claude Code

```
Install and configure mind-mcp by following the instructions here:
https://raw.githubusercontent.com/wonsong82/mind-mcp/refs/heads/main/install/CLAUDE_INSTALLATION_GUIDE.md
```

### OpenCode (OmO)

```
Install and configure mind-mcp by following the instructions here:
https://raw.githubusercontent.com/wonsong82/mind-mcp/refs/heads/main/install/OPENCODE_INSTALLATION_GUIDE.md
```

## How It Works

- **Short-term** — recently engaged topics, loaded at session start (~2-4 KB)
- **Long-term** — archived topics, searched on demand with pagination
- **Living documents** — each topic is a markdown file representing the current state of knowledge
- **Context logs** — JSONL files capturing full reasoning and user interactions behind each decision

The agent calls `mind_boot()` at session start to load short-term topic summaries. During conversation, it searches and loads topics as needed. After each turn, a hook nudges the agent to persist anything worth remembering.

Memory data lives in `.mind/` at the project root. Short-term topics auto-promote/demote via LRU. At project scale (50-500 topics), the LLM's semantic matching on topic summaries outperforms vector search.

## Tools

### `mind_boot`

Call once at session start. Returns short-term topic summaries and long-term stats.

```json
// Output
{
  "topics": [
    { "topic": "caching-strategy", "summary": "Chose Redis over Postgres...", "updated": "2026-04-09T14:30:00.000Z" }
  ],
  "long_term_count": 45,
  "long_term_pages": 3
}
```

### `mind_search`

Browse long-term archive. Returns paginated headers sorted by recency.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `page` | number | 1 | Page number |

### `mind_load`

Load a topic's full living document. Handles LRU promotion/demotion automatically.

| Param | Type | Description |
|-------|------|-------------|
| `topic` | string | Topic name (filename without `.md`) |

Checks both `short/` and `long/` — the agent never needs to know which folder a topic is in. If found in `long/`, it gets promoted to `short/`. The `updated` timestamp refreshes on every load (reading = engagement).

### `mind_load_log`

Load specific log entries by ID for full reasoning context.

| Param | Type | Description |
|-------|------|-------------|
| `topic` | string | Topic name |
| `ids` | number[] | Log entry IDs to retrieve |

### `mind_write`

Create or update a topic. Optionally append a log entry.

| Param | Type | Description |
|-------|------|-------------|
| `topic` | string | Topic name (kebab-case) |
| `summary` | string | Summary for the frontmatter — this is the search/trigger surface |
| `content` | string | Full body content (replaces existing). Include a `## History` section |
| `log_entry` | object? | Optional `{ summary, interaction }` — historical snapshot |
| `response` | string? | Orchestrator's full response — stored as `log_entry.context` server-side |

## Memory Format

Each topic is a living document with YAML frontmatter:

```markdown
---
summary: "Chose Redis over Postgres for caching. Benchmarked both under load."
updated: "2026-04-09T14:30:00.000Z"
---

Redis chosen for caching layer because it handles our access patterns
(high read, low write) with sub-ms latency. Postgres caching via
materialized views was 10x slower under concurrent load.

## History
- #1: Benchmarked Redis vs Postgres — Redis won on latency
- #2: Connection pooling config tuned (10 → 50)
- #3: Switched from redis-client to ioredis
```

Logs are JSONL files at `logs/{topic}.jsonl` — append-only historical snapshots. The History section bridges the living document to logs: scan one-liners to understand evolution, load specific `#N` via `mind_load_log` for the full picture.

## Configuration

Optional. Create `.mind/config.yml`:

```yaml
memory:
  short_term:
    limit: 20        # Max topics before oldest gets demoted
  long_term:
    page_size: 20    # Topics per page in mind_search results
```

Defaults apply if the file doesn't exist.

## What Gets Remembered

**Save:** decisions, discoveries, conventions, resolved issues, research findings, clarifications, corrections, procedural knowledge, user-requested notes.

**Skip:** cross-session user preferences (use native platform memory), trivial ephemeral actions, information already in project files.

**Key principle:** if you think "this is minor" — save it anyway. Future sessions can't derive it from reading the repo alone.

## License

MIT

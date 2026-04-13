# @wonflowoo/mind-mcp

Persistent **mind** for AI coding agents — structured knowledge via MCP tools. Complementary to platform-native memory features (like Claude Code's user-preference memory).

## Why "mind"?

Several platforms now have built-in memory systems (Claude Code's `~/.claude/projects/*/memory/`, etc.) that excel at **cross-session user preferences** ("user likes terse responses", "prefers Zod over Yup"). These are great for that purpose but aren't designed for:

- **Structured knowledge** — decisions, discoveries, conventions, resolved issues, research findings
- **Retrievable context logs** — full reasoning + user interactions behind each decision
- **LRU tiering** — short-term/long-term with paginated search at scale

`mind-mcp` fills that gap. The `mind_*` tools coexist with native memory — use native for cross-session preferences, `mind_*` for accumulated knowledge.

## How It Works

- **Short-term mind** — recently engaged topics, loaded at session start
- **Long-term mind** — archived topics, searched on demand with pagination
- **Living documents** — each topic is a freeform markdown file representing current state of knowledge
- **Context logs** — JSONL files capturing full reasoning, user interactions, and decision context

The agent's LLM does the semantic matching. No vector DB, no embeddings, no external services. Just files + an LLM that already understands meaning.

## Directory Resolution

The server checks for directories in this order:

1. If `.wonflowoo/` exists → uses `.wonflowoo/workspace/` as root
   - Config: `.wonflowoo/workspace/config.yml` (under `memory:` key)
   - Storage: `.wonflowoo/workspace/memory/{short,long,logs}/`
2. If `.wonflowoo/` not found → uses `.mind/` as root
   - Config: `.mind/config.yml`
   - Storage: `.mind/memory/{short,long,logs}/`

Directories are created automatically on first run.

## Setup

### WonfloWoo Projects

Already configured. `bin/wonflowoo init` sets up the MCP server, hooks, and agent instructions automatically.

### Standalone Projects

Add to `.mcp.json` at project root (works for both OpenCode and Claude Code):

```json
{
  "mcpServers": {
    "mind": {
      "type": "stdio",
      "command": "node",
      "args": [".wonflowoo/framework/packages/mind-mcp/dist/index.js"]
    }
  }
}
```

## Directory Structure

```
.wonflowoo/workspace/          # or .mind/ for standalone
├── config.yml                  # Optional — mind settings
├── memory/
│   ├── short/                  # Hot topics (headers loaded at boot)
│   │   └── *.md
│   ├── long/                   # Archived topics (searched on demand)
│   │   └── *.md
│   └── logs/                   # Historical snapshots (JSONL, queried by ID)
│       └── *.jsonl
```

## Living Document Format

Each `.md` file in `short/` or `long/` is a living document with a YAML frontmatter header:

```markdown
---
summary: "Chose Redis over Postgres for caching. Benchmarked both under load."
updated: "2026-04-09T14:30:00.000Z"
---

Redis chosen for caching layer because it handles our access patterns
(high read, low write) with sub-ms latency. Postgres caching via
materialized views was 10x slower under concurrent load.

Switched from redis-client to ioredis after discovering connection
pooling issues in production.

## History
- #1: Benchmarked Redis vs Postgres — Redis won on latency
- #2: Connection pooling config tuned (10 → 50)
- #3: Switched from redis-client to ioredis
- #4: Fixed ioredis reconnection config
```

**Header fields:**
- `summary` — rich description used as the search/trigger surface for the LLM
- `updated` — ISO timestamp of last engagement (read or write, not just modification)

**Body:** freeform markdown — the full current state of knowledge. Gets rewritten on updates. Ends with a **History** section listing one-liner summaries with `#N` references. The History section bridges the living document to the log snapshots — scan the one-liners to understand evolution, load specific `#N` via `mind_load_log` for the full picture at that point.

Convention: log file always matches the entry filename — `topic.md` → `logs/topic.jsonl`.

## Log Format

Each topic has a JSONL log file at `logs/{topic}.jsonl`:

```jsonl
{"id":1,"summary":"Benchmarked Redis vs Postgres","context":"Benchmarked both under 500 concurrent connections. Redis: 0.3ms p99. Postgres materialized views: 3.2ms p99. Redis handles our access patterns (high read, low write) with sub-ms latency.","interaction":"User asked 'should we use Redis or Postgres for caching?' After showing benchmarks, user said 'Redis, clearly.'"}
{"id":2,"summary":"Connection pooling config tuned","context":"Default pool size of 10 was insufficient for 200 concurrent requests. Increased to 50 with idle timeout of 30s.","interaction":"User reported intermittent timeouts in staging."}
```

Logs are **historical snapshots** — append-only, never modified. Each entry captures the full state at that point in time. Content evolves (gets rewritten on updates); logs preserve what was known at each change point. Load specific entries via `mind_load_log` when you need to recall a past state.

## Tools

### `mind_boot`

Call once at session start. Returns short-term topic summaries and long-term stats.

**Input:** none

**Output:**
```json
{
  "topics": [
    { "topic": "caching-strategy", "summary": "Chose Redis over Postgres...", "updated": "2026-04-09T14:30:00.000Z" },
    { "topic": "auth-flow", "summary": "JWT with httpOnly cookies...", "updated": "2026-04-08T10:00:00.000Z" }
  ],
  "long_term_count": 45,
  "long_term_pages": 3
}
```

### `mind_search`

Browse long-term archive. Returns paginated headers sorted by recency.

**Input:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `page` | number | 1 | Page number |

**Output:**
```json
{
  "topics": [
    { "topic": "bootstrap-scaling", "summary": "Pipeline stalled at step 6...", "updated": "2026-03-27T09:00:00.000Z" }
  ],
  "page": 1,
  "total_pages": 3,
  "total_count": 45
}
```

Agent scans returned summaries for semantic relevance. If not found, call with increasing page numbers to search deeper.

### `mind_load`

Load a topic's full living document. Handles LRU promotion/demotion and timestamp update automatically.

**Input:**
| Param | Type | Description |
|-------|------|-------------|
| `topic` | string | Topic name (filename without `.md`) |

The tool checks both `short/` and `long/` — the agent never needs to know which folder a topic is in. If found in `long/`, it gets promoted to `short/`. If `short/` exceeds the limit, the oldest topic gets demoted to `long/`. The `updated` timestamp is refreshed on every load (reading = engagement).

**Output:**
```json
{
  "found": true,
  "content": "---\nsummary: \"Chose Redis...\"\nupdated: \"2026-04-09T18:00:00.000Z\"\n---\n\nRedis chosen for caching..."
}
```

### `mind_load_log`

Load specific log entries by ID. Use when a living document has `(log: #N)` annotations and you need the full reasoning/context behind a decision.

**Input:**
| Param | Type | Description |
|-------|------|-------------|
| `topic` | string | Topic name |
| `ids` | number[] | Log entry IDs to retrieve |

**Output:**
```json
[
  { "id": 1, "summary": "Chose Redis over Postgres", "context": "Benchmarked both...", "interaction": "User asked..." },
  { "id": 3, "summary": "Switched to ioredis", "context": "redis-client had...", "interaction": "User reported..." }
]
```

### `mind_write`

Create or update a mind topic. Optionally append a log entry.

**Input:**
| Param | Type | Description |
|-------|------|-------------|
| `topic` | string | Topic name |
| `summary` | string | Summary for the frontmatter header |
| `content` | string | Full body content (replaces existing body) |
| `log_entry` | object? | Optional `{ summary, context, interaction }` |

The `content` is the living document body — full current state of knowledge. When updating, rewrite the body to reflect the latest state. Include a `## History` section at the bottom with one-liner summaries and `#N` references for each change point.

The `log_entry` is a historical snapshot — what was known/discussed at this point. Content evolves; logs are permanent. When providing a log_entry, add a corresponding `#N` entry to the History section in content.

**Output:**
```json
{
  "success": true,
  "log_id": 4
}
```

## Configuration

YAML config at `config.yml` (inside the resolved root directory):

```yaml
memory:
  short_term:
    limit: 20
  long_term:
    page_size: 20
```

| Setting | Default | Description |
|---------|---------|-------------|
| `memory.short_term.limit` | 20 | Max topics in `short/` before oldest gets demoted |
| `memory.long_term.page_size` | 20 | Topics per page in `mind_search` results |

If the file doesn't exist or the `memory:` key is absent, defaults are used.

## Write Trigger Hook

**Single hook, both platforms.** The MCP server provides storage and retrieval. To nudge the agent to write to mind after completing work, a single `Stop` hook in `.claude/settings.json` drives both OpenCode (via OmO's Claude Code compatibility layer) and Claude Code natively.

### Installation

Add to `.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "input=$(cat); sid=$(echo \"$input\" | sed -n 's/.*\"session_id\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p'); [ -z \"$sid\" ] && exit 0; lock=\"/tmp/mind-stop-${sid}.lock\"; if [ -f \"$lock\" ]; then rm -f \"$lock\"; exit 0; fi; touch \"$lock\"; printf '{\"decision\":\"block\",\"reason\":\"[MIND] Dispatch mind-curator with what happened this turn. Do NOT evaluate worthiness - the curator decides.\"}'"
          }
        ]
      }
    ]
  }
}
```

`wonflowoo init` installs this automatically.

### How It Works

The bash command:
1. Reads stdin JSON (hook input with `session_id`, `hook_event_name`, etc.)
2. Extracts `session_id` via sed regex
3. Checks `/tmp/mind-stop-{session_id}.lock`
4. **First fire:** creates lock, prints `{"decision":"block","reason":"[MIND] Dispatch mind-curator..."}` → platform injects the instruction, agent dispatches curator
5. **Second fire (after nudge response):** removes lock, exits 0 → session allowed to idle
6. **Next user turn:** cycle repeats

Result: exactly ONE mind nudge per user interaction. No infinite loops.

### Why File-Based Lock (Not `stop_hook_active`)

Initial attempts used Claude Code's native `stop_hook_active` flag. This works on Claude Code but fails on OpenCode (via OmO adapter) because OmO only updates its internal state map if the hook explicitly returns `stop_hook_active: true` in stdout — which standard hooks don't. The file-based lock is platform-agnostic and needs no adapter cooperation.

### Wrong Patterns That Cause Loops

- `"type": "prompt"` — sends to Haiku for pass/fail evaluation → when `mind_write` isn't called, Haiku flags error → agent responds → another Stop fires → Haiku re-evaluates → infinite loop
- Bare `echo` without JSON decision — stdout shown but not injected into conversation
- Block without session lock check — every agent response triggers another block forever

### What's Worth Writing to Mind

**Write:** decisions, discoveries, conventions, resolved issues, research findings, clarifications, corrections, procedural knowledge, user-requested notes.

**Skip (use native memory or just respond):** cross-session user preferences (communication style), trivial ephemeral actions, information already in existing files, workflow state (use drafts).

**Important:** If you think "this is minor" or "this is just a convention" — SAVE IT ANYWAY. Future sessions cannot derive these from reading the repo alone.

## Concurrency

Multiple sessions in the same project are safe. The server uses atomic directory-based locking (POSIX `mkdir`) for all write operations with a 5-second timeout.

## Design

No vector DB. No embeddings. No external services.

The agent's LLM reads topic summaries and does semantic matching directly — it's already better at understanding meaning than any embedding model. At project scale (50-500 topics), this approach is faster, simpler, and more accurate than vector search.

Short-term topics are loaded at boot (~2-4 KB). Long-term topics are searched on demand in paginated batches. Living documents are loaded individually when relevant. Log entries are loaded by specific ID. Typical session memory overhead: ~6 KB.

If a project ever exceeds 500+ topics, a vector DB layer can be added on top without changing the file structure.

## License

MIT

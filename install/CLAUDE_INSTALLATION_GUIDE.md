# mind-mcp Installation Guide — Claude Code

You are installing **mind-mcp**, a persistent memory system for AI coding agents. Follow every step below exactly. Do not skip steps.

## Prerequisites

- Node.js >= 18
- git

## Step 1 — Clone the Repository

Clone mind-mcp into a hidden directory at your project root:

```bash
git clone https://github.com/wonsong82/mind-mcp.git .mind-mcp
```

## Step 2 — Build the MCP Server

```bash
cd .mind-mcp && npm install && npm run build
```

Verify `dist/index.js` exists after the build.

## Step 3 — Configure MCP

Create or update `.mcp.json` at the project root. If the file already exists, merge the `mind` entry into the existing `mcpServers` object — do NOT overwrite other servers.

```json
{
  "mcpServers": {
    "mind": {
      "type": "stdio",
      "command": "node",
      "args": [".mind-mcp/dist/index.js"]
    }
  }
}
```

## Step 4 — Install the Mind Curator Agent

Copy the agent config into your project's Claude agents directory:

```bash
mkdir -p .claude/agents
cp .mind-mcp/install/.claude/agents/mind-curator.md .claude/agents/mind-curator.md
```

## Step 5 — Install the Write Hook

The write hook nudges you to dispatch `@mind-curator` after each user interaction. It uses a lock file to fire exactly once per turn.

Create or update `.claude/settings.json` at the project root. If the file already exists, merge the `Stop` hook into the existing `hooks` object — do NOT overwrite other hooks.

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "input=$(cat); sid=$(echo \"$input\" | sed -n 's/.*\"session_id\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p'); [ -z \"$sid\" ] && exit 0; lock=\"/tmp/mind-stop-${sid}.lock\"; if [ -f \"$lock\" ]; then rm -f \"$lock\"; exit 0; fi; tp=$(echo \"$input\" | sed -n 's/.*\"transcript_path\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p'); if [ -n \"$tp\" ] && [ -f \"$tp\" ]; then tail -5 \"$tp\" | grep -q 'OMO_INTERNAL_INITIATOR\\|system-reminder' && exit 0; fi; db=\"${HOME}/.local/share/opencode/opencode.db\"; if [ -f \"$db\" ] && command -v sqlite3 >/dev/null 2>&1; then last=$(sqlite3 \"$db\" \"SELECT p.data FROM part p JOIN message m ON p.message_id = m.id WHERE p.session_id='${sid}' AND json_extract(m.data, '$.role')='user' ORDER BY p.time_created DESC LIMIT 1;\" 2>/dev/null); case \"$last\" in *system-reminder*|*OMO_INTERNAL_INITIATOR*) exit 0 ;; esac; fi; touch \"$lock\"; printf '{\"decision\":\"block\",\"reason\":\"[MIND] Dispatch mind-curator with what happened this turn. After your summary, include your complete response to the user under a RESPONSE heading.\"}'"
          }
        ]
      }
    ]
  }
}
```

## Step 6 — Add Mind Instructions to CLAUDE.md

Add the following block to the project's `CLAUDE.md` (create the file if it doesn't exist). Place it near the top so it's loaded early in every session.

```markdown
## Mind Memory

### Session Start (MANDATORY)

Call `mind_boot()` as your FIRST action in every new session — before reading any files, before analyzing the directory, before asking questions. The result is your memory from previous sessions. Skipping this means working blind against project history.

### During Conversation

ALWAYS consult mind before answering questions about the project:

1. Check your boot context (the `mind_boot()` result) for the topic
2. If not found, call `mind_search()` — the topic may be in the long-term archive
3. When you find a relevant topic, call `mind_load("topic-name")` for the full content
4. If the History section references `#N` entries you need, call `mind_load_log("topic-name", [N])`

### Rules

- **"Make a note" / "remember this"** — dispatch `@mind-curator` to persist to memory
- **`[MIND]` nudge** — dispatch `@mind-curator` with a summary of what happened this turn. After your summary, include your complete response to the user under a `## RESPONSE` heading
```

## Step 7 — Update .gitignore

Add these entries to `.gitignore`:

```
# mind-mcp
.mind-mcp/
.mind/
```

> **Note:** `.mind/` contains the memory data. If you want shared team memory, remove `.mind/` from gitignore and commit it.

## Step 8 — Verify

Restart your Claude Code session. On the first message, you should see `mind_boot()` called as the first tool action. If it's not called, check that the CLAUDE.md instructions were added correctly.

To test the write hook: after your first response, the Stop hook should fire and you should see a `[MIND]` nudge prompting you to dispatch `@mind-curator`.

## Directory Layout After Installation

```
your-project/
├── .claude/
│   ├── agents/
│   │   └── mind-curator.md        # Curator agent config
│   └── settings.json              # Write hook
├── .mind-mcp/                     # Cloned repo (gitignored)
│   ├── dist/                      # Built MCP server
│   ├── install/                   # Installation files
│   └── ...
├── .mind/                         # Memory storage (auto-created on first write)
│   ├── memory/
│   │   ├── short/                 # Hot topics (loaded at boot)
│   │   ├── long/                  # Archived topics (searched on demand)
│   │   └── logs/                  # Historical snapshots (JSONL)
│   └── config.yml                 # Optional config overrides
├── .mcp.json                      # MCP server config
└── CLAUDE.md                      # Agent instructions (with mind section)
```

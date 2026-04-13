#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { MemoryStorage } from './storage.js';

const server = new McpServer({
  name: 'mind-mcp',
  version: '0.1.0',
});

const storage = new MemoryStorage(process.cwd());

const searchInputSchema = z.object({
  page: z.number().int().min(1).optional(),
});

const loadInputSchema = z.object({
  topic: z.string().min(1),
});

const loadLogInputSchema = z.object({
  topic: z.string().min(1),
  ids: z.array(z.number().int()),
});

const writeInputSchema = z.object({
  topic: z.string().min(1),
  summary: z.string(),
  content: z.string(),
  log_entry: z
    .object({
      summary: z.string(),
      context: z.string().optional(),
      interaction: z.string(),
    })
    .optional(),
  response: z.string().optional(),
});

function jsonResult(value: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

server.registerTool(
  'mind_boot',
  {
    description:
      'Load short-term mind index at session start. Returns topic summaries for all recently-engaged memories plus long-term archive stats (count and page count). Call this ONCE at the beginning of every session to orient yourself. Mind is persistent structured knowledge — decisions, discoveries, conventions, resolved issues, research findings, and anything worth remembering across sessions.',
  },
  async () => jsonResult(await storage.memoryBoot()),
);

server.registerTool(
  'mind_search',
  {
    description:
      'Search long-term mind archive by page. Returns topic summaries sorted by recency. Use when a topic is not found in short-term boot context. Scan returned summaries for semantic relevance, then call mind_load for the matching topic. Call with increasing page numbers to search deeper.',
    inputSchema: searchInputSchema,
  },
  async ({ page }) => jsonResult(await storage.memorySearch(page ?? 1)),
);

server.registerTool(
  'mind_load',
  {
    description:
      'Load a mind topic by name. Returns the full living document (current state of knowledge). Automatically promotes long-term topics to short-term and updates engagement timestamp. Use after identifying a relevant topic from boot context or search results. Check log annotations like (log: #2, #5) in the content — use mind_load_log to retrieve full reasoning behind those entries.',
    inputSchema: loadInputSchema,
  },
  async ({ topic }) => jsonResult(await storage.memoryLoad(topic)),
);

server.registerTool(
  'mind_load_log',
  {
    description:
      'Load specific log entries for a mind topic by their IDs. Returns full context including user interactions, reasoning, and decision details. Use when a living document references log entries via (log: #N) annotations and you need the deeper context behind a decision.',
    inputSchema: loadLogInputSchema,
  },
  async ({ topic, ids }) => jsonResult(await storage.memoryLoadLog(topic, ids)),
);

server.registerTool(
  'mind_write',
  {
    description:
      'Create or update a mind topic. Writes the living document (current state of knowledge) and optionally appends a historical snapshot as a log entry.\n\nINTENDED CALLER: the mind-curator sub-agent. The main orchestrator should NOT call this directly — dispatch mind-curator instead.\n\nContent is the living document — full current state, rewritten on updates. Include a History section at the bottom with #N references for each change point. Log entries are historical snapshots — append-only, never modified.\n\nThe `response` field captures the orchestrator full response verbatim. When provided, the server stores it as log_entry.context automatically — no need to duplicate it in log_entry.context.\n\nReturns the assigned log ID for confirmation.',
    inputSchema: writeInputSchema,
  },
  async (input) => jsonResult(await storage.memoryWrite(input)),
);

async function main(): Promise<void> {
  await storage.ensureInitialized();

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error('mind-mcp server error:', error);
  process.exit(1);
});

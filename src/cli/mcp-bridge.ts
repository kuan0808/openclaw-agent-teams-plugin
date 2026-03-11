#!/usr/bin/env node
/**
 * MCP Bridge — Standalone MCP server for CLI agents.
 *
 * This script runs as a separate process spawned by CLI agents' MCP runtime.
 * It bridges MCP tool calls to the main plugin process via Unix domain socket IPC.
 *
 * Environment variables:
 *  - AT_AGENT_ID — e.g., "at--eng--frontend"
 *  - AT_SOCK_PATH — path to IPC Unix socket
 *
 * Protocol: JSON-RPC over line-delimited JSON on Unix socket.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as net from "node:net";

// ── Environment ───────────────────────────────────────────────────────────

const AGENT_ID = process.env.AT_AGENT_ID;
const SOCK_PATH = process.env.AT_SOCK_PATH;

if (!AGENT_ID || !SOCK_PATH) {
  console.error("Missing required environment variables: AT_AGENT_ID, AT_SOCK_PATH");
  process.exit(1);
}

// ── IPC Client ────────────────────────────────────────────────────────────

let requestCounter = 0;

async function ipcCall(method: string, params: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = String(++requestCounter);
    const socket = net.createConnection({ path: SOCK_PATH! }, () => {
      const request = JSON.stringify({
        id,
        method,
        agentId: AGENT_ID,
        params,
      });
      socket.write(request + "\n");
    });

    let buffer = "";

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("IPC call timed out"));
    }, 30000);

    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const response = JSON.parse(trimmed);
          if (response.id === id) {
            clearTimeout(timer);
            socket.end();
            if (response.error) {
              reject(new Error(response.error));
            } else {
              resolve(response.result);
            }
            return;
          }
        } catch {
          // Ignore parse errors on incomplete data
        }
      }
    });

    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`IPC connection failed: ${err.message}`));
    });

    socket.on("close", () => {
      // If we haven't resolved yet, the connection closed unexpectedly
    });
  });
}

// ── Tool Definitions ──────────────────────────────────────────────────────

const TOOL_DEFINITIONS = [
  {
    name: "team_run",
    description: "Manage team execution runs. Start a new run with a goal, check status, mark complete, or cancel.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: { type: "string", enum: ["start", "status", "complete", "cancel"], description: "Run lifecycle action" },
        goal: { type: "string", description: "Goal for the run (required for action=start)" },
        result: { type: "string", description: "Result summary (for action=complete)" },
        reason: { type: "string", description: "Cancellation reason (for action=cancel)" },
      },
      required: ["action"],
    },
  },
  {
    name: "team_task",
    description: "Create, update, and query tasks within a team run. Supports skill-based routing, dependency management, deliverables tracking, and approval gates.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: { type: "string", enum: ["create", "update", "query"], description: "Task action" },
        description: { type: "string", description: "Task description (required for create)" },
        assign_to: { type: "string", description: "Directly assign to a specific member" },
        required_skills: { type: "array", items: { type: "string" }, description: "Skills needed for routing" },
        depends_on: { type: "array", items: { type: "string" }, description: "Task IDs this task depends on" },
        task_id: { type: "string", description: "Task ID (required for update)" },
        status: {
          type: "string",
          enum: ["BLOCKED", "PENDING", "WORKING", "INPUT_REQUIRED", "COMPLETED", "FAILED", "CANCELED"],
          description: "New task status",
        },
        result: { type: "string", description: "Task result (for update)" },
        message: { type: "string", description: "Status message (for update)" },
        filter_status: { type: "array", items: { type: "string" }, description: "Filter tasks by status" },
        deliverables: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["file", "url", "artifact", "doc"] },
              path: { type: "string" },
              url: { type: "string" },
              doc_key: { type: "string" },
              description: { type: "string" },
            },
          },
          description: "Deliverables to register with the task",
        },
        learning: {
          type: "object",
          properties: {
            content: { type: "string", description: "What was learned" },
            confidence: { type: "number", description: "Confidence 0.0-1.0" },
            category: { type: "string", enum: ["failure", "pattern", "fix", "insight"] },
          },
          description: "Structured learning to capture",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "team_memory",
    description: "Read and write shared team memory. Supports key-value store (ephemeral data, counters, flags) and document pool (larger content, markdown, data files).",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: { type: "string", enum: ["get", "set", "delete", "list"], description: "Memory action" },
        store: { type: "string", enum: ["kv", "docs"], description: "Target store (default: kv)" },
        key: { type: "string", description: "Key name (required for get/set/delete)" },
        value: { type: "string", description: "Value to store" },
        ttl: { type: "number", description: "Time-to-live in seconds (KV store only)" },
        content_type: { type: "string", description: "Content type for docs" },
      },
      required: ["action"],
    },
  },
  {
    name: "team_send",
    description: "Send messages to team members or publish events to the team event queue. Use 'to' for direct messages, 'topic' for event publishing, or both.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to: { type: "string", description: "Target member name, or \"all\" for broadcast" },
        message: { type: "string", description: "Message content" },
        topic: { type: "string", description: "Publish to this event queue topic" },
        data: { type: "string", description: "JSON data payload for event queue messages" },
      },
      required: ["message"],
    },
  },
  {
    name: "team_inbox",
    description: "Read messages from your team inbox (direct messages) or subscribe to event queue topics.",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: { type: "number", description: "Maximum messages to return (default: 10)" },
        ack: { type: "boolean", description: "Mark messages as read (default: true)" },
        topic: { type: "string", description: "Read from event queue topic" },
        since: { type: "string", description: "ISO timestamp — only return events after this time" },
        source: { type: "string", enum: ["inbox", "events", "activity"], description: "Data source (default: inbox)" },
        action: { type: "string", enum: ["read", "list_topics"], description: "Action (default: read)" },
        filter_type: { type: "string", description: "Filter by activity type (source=activity only)" },
        filter_agent: { type: "string", description: "Filter by member name (source=activity only)" },
      },
    },
  },
];

const VALID_TOOL_NAMES = new Set(TOOL_DEFINITIONS.map((t) => t.name));

// ── MCP Server Setup ──────────────────────────────────────────────────────

const server = new Server(
  {
    name: "agent-teams-bridge",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// List tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_DEFINITIONS,
}));

// Execute tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (!VALID_TOOL_NAMES.has(name)) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
      isError: true,
    };
  }

  try {
    const result = await ipcCall(name, (args ?? {}) as Record<string, unknown>);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: JSON.stringify({ error: message }) }],
      isError: true,
    };
  }
});

// ── Start Server ──────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("MCP Bridge failed to start:", err);
  process.exit(1);
});

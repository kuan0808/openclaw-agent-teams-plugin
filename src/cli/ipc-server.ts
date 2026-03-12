/**
 * IPC Server — local transport server for CLI agent tool proxy.
 *
 * Starts a JSON-RPC server on either:
 * - a Unix domain socket path like `{stateDir}/ipc.sock`
 * - a loopback TCP endpoint like `tcp://127.0.0.1:4567`
 *
 * CLI agents communicate with the main plugin process through
 * MCP bridge → IPC transport → tool execution.
 *
 * Delegates to the actual tool factory functions (teamRunTool, teamTaskTool, etc.)
 * to ensure behavioral parity with native subagents (gates, workflow templates,
 * CLI auto-spawn, etc.).
 *
 * Protocol: line-delimited JSON (one JSON object per line).
 * Request:  {"id":"1","method":"team_send","agentId":"at--eng--frontend","params":{...}}
 * Response: {"id":"1","result":{...}} or {"id":"1","error":"..."}
 */

import * as net from "node:net";
import * as fs from "node:fs";
import { type PluginRegistry, resolveAgentSession } from "../registry.js";
import { parseAgentId, makeAgentId } from "../types.js";

// Import tool factories — single source of truth for all tool logic
import { teamRunTool } from "../tools/team-run.js";
import { teamTaskTool } from "../tools/team-task.js";
import { teamMemoryTool } from "../tools/team-memory.js";
import { teamSendTool } from "../tools/team-send.js";
import { teamInboxTool } from "../tools/team-inbox.js";
import type { ToolContext } from "../tools/tool-helpers.js";

// ── Types ─────────────────────────────────────────────────────────────────

interface IpcRequest {
  id: string;
  method: string;
  agentId: string;
  params: Record<string, unknown>;
}

interface IpcResponse {
  id: string;
  result?: unknown;
  error?: string;
}

type ToolMethod = "team_run" | "team_task" | "team_memory" | "team_send" | "team_inbox";

// ── Tool factory map ──────────────────────────────────────────────────────

const TOOL_FACTORIES: Record<ToolMethod, (ctx: ToolContext) => { execute: (id: string, params: any) => Promise<{ details?: unknown }> }> = {
  team_run: teamRunTool,
  team_task: teamTaskTool,
  team_memory: teamMemoryTool,
  team_send: teamSendTool,
  team_inbox: teamInboxTool,
};

const VALID_METHODS = new Set<string>(Object.keys(TOOL_FACTORIES));

// ── IPC Server ────────────────────────────────────────────────────────────

export class IpcServer {
  private server: net.Server | null = null;
  private connections: Set<net.Socket> = new Set();
  private effectiveEndpoint: string;

  constructor(
    private sockPath: string,
    private registry: PluginRegistry,
  ) {
    this.effectiveEndpoint = sockPath;
  }

  getEndpoint(): string {
    return this.effectiveEndpoint;
  }

  async start(): Promise<void> {
    const endpoint = parseEndpoint(this.sockPath);

    if (endpoint.kind === "unix") {
      try {
        fs.unlinkSync(endpoint.path);
      } catch {
        // Ignore if it doesn't exist
      }
    }

    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.connections.add(socket);
        let buffer = "";

        socket.on("data", (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split("\n");
          // Keep incomplete last line in buffer
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            this.handleLine(trimmed, socket);
          }
        });

        socket.on("close", () => {
          this.connections.delete(socket);
        });

        socket.on("error", () => {
          this.connections.delete(socket);
        });
      });

      this.server.on("error", reject);

      if (endpoint.kind === "unix") {
        this.server.listen(endpoint.path, () => {
          this.effectiveEndpoint = endpoint.path;
          resolve();
        });
        return;
      }

      this.server.listen(endpoint.port, endpoint.host, () => {
        const address = this.server?.address();
        if (!address || typeof address === "string") {
          reject(new Error("Failed to resolve TCP IPC address."));
          return;
        }
        this.effectiveEndpoint = `tcp://${address.address}:${address.port}`;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const conn of this.connections) {
      conn.destroy();
    }
    this.connections.clear();

    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => {
        const endpoint = parseEndpoint(this.sockPath);
        if (endpoint.kind === "unix") {
          try {
            fs.unlinkSync(endpoint.path);
          } catch {
            // Ignore
          }
        }
        resolve();
      });
    });
  }

  private async handleLine(line: string, socket: net.Socket): Promise<void> {
    let request: IpcRequest;
    try {
      request = JSON.parse(line) as IpcRequest;
    } catch {
      this.writeResponse(socket, { id: "?", error: "Invalid JSON" });
      return;
    }

    if (!request.id || !request.method || !request.agentId) {
      this.writeResponse(socket, {
        id: request.id ?? "?",
        error: "Missing required fields: id, method, agentId",
      });
      return;
    }

    try {
      const result = await this.executeToolMethod(
        request.method,
        request.agentId,
        request.params ?? {},
      );
      this.writeResponse(socket, { id: request.id, result });

      // Push notification: notify orchestrator on task completion/failure
      if (request.method === "team_task") {
        const status = request.params.status as string | undefined;
        if (status === "COMPLETED" || status === "FAILED") {
          this.notifyOrchestrator(request.agentId, status, request.params.task_id as string | undefined);
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.writeResponse(socket, { id: request.id, error: message });
    }
  }

  private writeResponse(socket: net.Socket, response: IpcResponse): void {
    try {
      socket.write(JSON.stringify(response) + "\n");
    } catch {
      // Socket may have closed
    }
  }

  /**
   * Notify orchestrator when a CLI agent completes or fails a task.
   * Provides push notification so orchestrator doesn't need to poll.
   */
  private notifyOrchestrator(agentId: string, status: string, taskId?: string): void {
    const parsed = parseAgentId(agentId);
    if (!parsed) return;

    const { team, member } = parsed;
    const teamConfig = this.registry.getTeamConfig(team);
    if (!teamConfig?.orchestrator) return;

    const orchId = makeAgentId(team, teamConfig.orchestrator);
    const orchSession = resolveAgentSession(this.registry, orchId);
    if (!orchSession) return;

    const taskRef = taskId ? ` task ${taskId}` : "";
    this.registry.enqueueSystemEvent(
      `[Team Update] Agent "${member}" ${status.toLowerCase()}${taskRef}. Check team_inbox for details.`,
      { sessionKey: orchSession },
    );
    this.registry.requestHeartbeatNow({ agentId: orchId, sessionKey: orchSession });
  }

  // ── Tool execution via factories ────────────────────────────────────────

  private async executeToolMethod(
    method: string,
    agentId: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (!VALID_METHODS.has(method)) {
      throw new Error(`Unknown method: ${method}`);
    }

    const factory = TOOL_FACTORIES[method as ToolMethod];
    const ctx: ToolContext = { agentId };
    const tool = factory(ctx);
    const result = await tool.execute("ipc", params);

    // Tools return { content, details } via textResult/errorResult.
    // errorResult wraps as textResult({ error: message }).
    const details = result.details as Record<string, unknown> | undefined;
    if (details?.error) {
      throw new Error(details.error as string);
    }

    return details;
  }
}

type IpcEndpoint =
  | { kind: "unix"; path: string }
  | { kind: "tcp"; host: string; port: number };

function parseEndpoint(endpoint: string): IpcEndpoint {
  if (!endpoint.startsWith("tcp://")) {
    return { kind: "unix", path: endpoint };
  }

  const parsed = new URL(endpoint);
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid IPC TCP endpoint: ${endpoint}`);
  }

  return {
    kind: "tcp",
    host: parsed.hostname || "127.0.0.1",
    port,
  };
}

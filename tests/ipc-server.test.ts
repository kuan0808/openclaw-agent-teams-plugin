import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as net from "node:net";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import { IpcServer } from "../src/cli/ipc-server.js";
import type { PluginRegistry, TeamStores } from "../src/registry.js";
import { setRegistry } from "../src/registry.js";

// ── Helpers ───────────────────────────────────────────────────────────────

function sendIpcRequest(
  sockPath: string,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: sockPath }, () => {
      socket.write(JSON.stringify(request) + "\n");
    });

    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const response = JSON.parse(trimmed);
          socket.end();
          resolve(response);
          return;
        } catch {
          // Incomplete
        }
      }
    });

    socket.on("error", reject);
    setTimeout(() => {
      socket.destroy();
      reject(new Error("Timeout"));
    }, 5000);
  });
}

function createMockStores(): TeamStores {
  const mockRuns = {
    getRun: vi.fn().mockReturnValue({ found: false }),
    listTasks: vi.fn().mockReturnValue([]),
    addTask: vi.fn().mockImplementation((_team: string, taskData: Record<string, unknown>) => ({
      ...taskData,
      created_at: Date.now(),
      updated_at: Date.now(),
    })),
    updateTask: vi.fn(),
    getTask: vi.fn(),
    startRun: vi.fn().mockReturnValue({ run_id: "run-test", status: "WORKING" }),
    completeRun: vi.fn().mockReturnValue({ ok: true, status: "COMPLETED" }),
    cancelRun: vi.fn().mockReturnValue({ ok: true, status: "CANCELED", tasks_canceled: 0 }),
    save: vi.fn().mockResolvedValue(undefined),
  };

  const mockKv = {
    get: vi.fn().mockReturnValue({ found: false }),
    set: vi.fn().mockReturnValue({ replaced: false }),
    delete: vi.fn().mockReturnValue(true),
    list: vi.fn().mockReturnValue([]),
    save: vi.fn().mockResolvedValue(undefined),
    *iterEntries() {
      // empty
    },
  };

  const mockEvents = {
    publish: vi.fn().mockReturnValue("evt-1"),
    read: vi.fn().mockReturnValue([]),
    getTopics: vi.fn().mockReturnValue([]),
    save: vi.fn().mockResolvedValue(undefined),
  };

  const mockDocs = {
    get: vi.fn().mockResolvedValue({ found: false }),
    set: vi.fn().mockResolvedValue({ size_bytes: 0 }),
    delete: vi.fn().mockResolvedValue(true),
    list: vi.fn().mockReturnValue([]),
    save: vi.fn().mockResolvedValue(undefined),
  };

  const mockMessages = {
    push: vi.fn(),
    read: vi.fn().mockReturnValue([]),
    save: vi.fn().mockResolvedValue(undefined),
  };

  const mockActivity = {
    log: vi.fn(),
    query: vi.fn().mockReturnValue([]),
    save: vi.fn().mockResolvedValue(undefined),
  };

  return {
    kv: mockKv,
    events: mockEvents,
    docs: mockDocs,
    runs: mockRuns,
    messages: mockMessages,
    activity: mockActivity,
  } as unknown as TeamStores;
}

function createMockRegistry(stores: TeamStores): PluginRegistry {
  return {
    config: {
      teams: {
        dev: {
          description: "Dev team",
          coordination: "orchestrator" as const,
          orchestrator: "lead",
          members: {
            lead: { role: "Tech lead" },
            frontend: { role: "Frontend dev", cli: "claude" as const },
            backend: { role: "Backend dev" },
          },
        },
      },
    },
    teams: new Map([["dev", stores]]),
    sessions: new Map(),
    getTeamStores: (team: string) => team === "dev" ? stores : undefined,
    getTeamConfig: (team: string) => team === "dev" ? {
      description: "Dev team",
      coordination: "orchestrator" as const,
      orchestrator: "lead",
      members: {
        lead: { role: "Tech lead" },
        frontend: { role: "Frontend dev", cli: "claude" as const },
        backend: { role: "Backend dev" },
      },
    } : undefined,
    enqueueSystemEvent: vi.fn().mockReturnValue(true),
    requestHeartbeatNow: vi.fn(),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

const tmpDir = path.join(os.tmpdir(), "at-test-ipc-" + Math.random().toString(36).slice(2));

describe("IpcServer", () => {
  let server: IpcServer;
  let sockPath: string;
  let stores: TeamStores;

  beforeEach(async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    sockPath = path.join(tmpDir, "ipc.sock");
    stores = createMockStores();
    const registry = createMockRegistry(stores);
    setRegistry(registry);
    server = new IpcServer(sockPath, registry);
    await server.start();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should start and accept connections", async () => {
    const response = await sendIpcRequest(sockPath, {
      id: "1",
      method: "team_run",
      agentId: "at--dev--frontend",
      params: { action: "status" },
    });

    expect(response.id).toBe("1");
    expect(response.result).toBeDefined();
    expect(response.error).toBeUndefined();
  });

  it("should reject invalid JSON", async () => {
    const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const socket = net.createConnection({ path: sockPath }, () => {
        socket.write("not json\n");
      });
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        for (const line of lines) {
          if (line.trim()) {
            try {
              resolve(JSON.parse(line.trim()));
              socket.end();
              return;
            } catch { /* continue */ }
          }
        }
      });
      socket.on("error", reject);
      setTimeout(() => { socket.destroy(); reject(new Error("Timeout")); }, 5000);
    });

    expect(response.error).toBe("Invalid JSON");
  });

  it("should reject missing required fields", async () => {
    const response = await sendIpcRequest(sockPath, {
      id: "2",
      method: "team_run",
      // missing agentId
      params: {},
    });

    expect(response.error).toBe("Missing required fields: id, method, agentId");
  });

  it("should reject unknown methods", async () => {
    const response = await sendIpcRequest(sockPath, {
      id: "3",
      method: "unknown_tool",
      agentId: "at--dev--frontend",
      params: {},
    });

    expect(response.error).toBeDefined();
    expect(response.error).toContain("Unknown method");
  });

  it("should proxy team_run status call", async () => {
    const response = await sendIpcRequest(sockPath, {
      id: "4",
      method: "team_run",
      agentId: "at--dev--frontend",
      params: { action: "status" },
    });

    expect(response.id).toBe("4");
    expect(response.result).toBeDefined();
    const result = response.result as Record<string, unknown>;
    expect(result.status).toBe("no_active_run");
  });

  it("should proxy team_run start call", async () => {
    const response = await sendIpcRequest(sockPath, {
      id: "5",
      method: "team_run",
      agentId: "at--dev--frontend",
      params: { action: "start", goal: "Build app" },
    });

    expect(response.id).toBe("5");
    expect(response.result).toBeDefined();
    const result = response.result as Record<string, unknown>;
    expect(result.run_id).toBe("run-test");
    expect(result.status).toBe("WORKING");
  });

  it("should proxy team_send call", async () => {
    const response = await sendIpcRequest(sockPath, {
      id: "6",
      method: "team_send",
      agentId: "at--dev--frontend",
      params: { to: "lead", message: "Hello from frontend" },
    });

    expect(response.id).toBe("6");
    expect(response.result).toBeDefined();
    const result = response.result as Record<string, unknown>;
    expect(result.from).toBe("frontend");
    expect(result.team).toBe("dev");
    expect(stores.messages.push).toHaveBeenCalledWith("frontend", "lead", "Hello from frontend");
  });

  it("should proxy team_inbox call", async () => {
    const response = await sendIpcRequest(sockPath, {
      id: "7",
      method: "team_inbox",
      agentId: "at--dev--frontend",
      params: {},
    });

    expect(response.id).toBe("7");
    expect(response.result).toBeDefined();
    const result = response.result as Record<string, unknown>;
    expect(result.source).toBe("inbox");
    expect(result.member).toBe("frontend");
  });

  it("should proxy team_memory kv get call", async () => {
    (stores.kv.get as ReturnType<typeof vi.fn>).mockReturnValue({
      found: true,
      value: "test-value",
      written_by: "lead",
      ttl_remaining: null,
    });

    const response = await sendIpcRequest(sockPath, {
      id: "8",
      method: "team_memory",
      agentId: "at--dev--frontend",
      params: { action: "get", key: "test-key" },
    });

    expect(response.id).toBe("8");
    expect(response.result).toBeDefined();
    const result = response.result as Record<string, unknown>;
    expect(result.found).toBe(true);
    expect(result.value).toBe("test-value");
  });

  it("should handle agent ID resolution errors", async () => {
    const response = await sendIpcRequest(sockPath, {
      id: "9",
      method: "team_run",
      agentId: "invalid-agent-id",
      params: { action: "status" },
    });

    expect(response.error).toBeDefined();
    expect(response.error).toContain("Cannot resolve team context");
  });

  it("should handle multiple concurrent requests", async () => {
    const promises = Array.from({ length: 5 }, (_, i) =>
      sendIpcRequest(sockPath, {
        id: String(100 + i),
        method: "team_run",
        agentId: "at--dev--frontend",
        params: { action: "status" },
      }),
    );

    const responses = await Promise.all(promises);
    expect(responses).toHaveLength(5);
    for (const resp of responses) {
      expect(resp.result).toBeDefined();
    }
  });
});

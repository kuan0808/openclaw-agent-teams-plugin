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
  server: IpcServer,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return dispatchRawLine(server, JSON.stringify(request));
}

function createMockStores(): TeamStores {
  const mockRuns = {
    getRun: vi.fn().mockReturnValue({ found: false }),
    listRuns: vi.fn().mockReturnValue([]),
    listTasks: vi.fn().mockReturnValue([]),
    addTask: vi.fn().mockImplementation((_team: string, taskData: Record<string, unknown>) => ({
      ...taskData,
      created_at: Date.now(),
      updated_at: Date.now(),
    })),
    updateTask: vi.fn(),
    getTask: vi.fn(),
    startRun: vi.fn().mockReturnValue({ run_id: "run-test", status: "WORKING" }),
    getWorkingRuns: vi.fn().mockReturnValue([]),
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
    memberSessions: new Map(),
    sessionIndex: new Map(),
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

async function dispatchRawLine(
  server: IpcServer,
  line: string,
): Promise<Record<string, unknown>> {
  const writes: string[] = [];
  const socket = {
    write: vi.fn((chunk: string) => {
      writes.push(chunk);
      return true;
    }),
  } as unknown as net.Socket;

  await (server as any).handleLine(line, socket);

  expect(writes.length).toBeGreaterThan(0);
  return JSON.parse(writes[0]!.trim()) as Record<string, unknown>;
}

describe("IpcServer", () => {
  let server: IpcServer;
  let stores: TeamStores;

  beforeEach(async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    stores = createMockStores();
    const registry = createMockRegistry(stores);
    setRegistry(registry);
    server = new IpcServer("tcp://127.0.0.1:0", registry);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should expose the configured endpoint before start", async () => {
    expect(server.getEndpoint()).toBe("tcp://127.0.0.1:0");
  });

  it("should reject invalid JSON", async () => {
    const response = await dispatchRawLine(server, "not json");

    expect(response.error).toBe("Invalid JSON");
  });

  it("should reject missing required fields", async () => {
    const response = await sendIpcRequest(server, {
      id: "2",
      method: "team_run",
      // missing agentId
      params: {},
    });

    expect(response.error).toBe("Missing required fields: id, method, agentId");
  });

  it("should reject unknown methods", async () => {
    const response = await sendIpcRequest(server, {
      id: "3",
      method: "unknown_tool",
      agentId: "at--dev--frontend",
      params: {},
    });

    expect(response.error).toBeDefined();
    expect(response.error).toContain("Unknown method");
  });

  it("should proxy team_run status call", async () => {
    const response = await sendIpcRequest(server, {
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

  it("should reject team_run start from team agent (subagent guard)", async () => {
    const response = await sendIpcRequest(server, {
      id: "5",
      method: "team_run",
      agentId: "at--dev--frontend",
      params: { action: "start", goal: "Build app" },
    });

    expect(response.id).toBe("5");
    expect(response.error).toContain("Team agents cannot start new runs");
  });

  it("should proxy team_send call", async () => {
    const response = await sendIpcRequest(server, {
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
    const response = await sendIpcRequest(server, {
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

    const response = await sendIpcRequest(server, {
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
    const response = await sendIpcRequest(server, {
      id: "9",
      method: "team_run",
      agentId: "invalid-agent-id",
      params: { action: "status" },
    });

    expect(response.error).toBeDefined();
    expect(response.error).toContain("Missing required 'team' parameter");
  });

  it("should handle multiple concurrent requests", async () => {
    const promises = Array.from({ length: 5 }, (_, i) =>
      sendIpcRequest(server, {
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

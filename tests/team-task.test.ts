import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/tools/cli-spawn-helper.js", () => ({
  spawnCliIfNeeded: vi.fn(async () => {}),
}));

import { setRegistry } from "../src/registry.js";
import { teamTaskTool } from "../src/tools/team-task.js";
import type { PluginRegistry, TeamStores } from "../src/registry.js";
import type { TeamConfig } from "../src/types.js";

function makeStores(): TeamStores {
  const tasks: Array<Record<string, unknown>> = [];
  return {
    kv: {
      set: vi.fn(),
      save: vi.fn(async () => {}),
      *iterEntries() {},
    } as unknown as TeamStores["kv"],
    events: {
      save: vi.fn(async () => {}),
    } as unknown as TeamStores["events"],
    docs: {} as TeamStores["docs"],
    runs: {
      getRun: vi.fn(() => ({
        found: true,
        run: { id: "run-1", tasks, requester_session: "main-agent-session" },
      })),
      listTasks: vi.fn(() => tasks as any),
      addTask: vi.fn((_team: string, task: Record<string, unknown>) => {
        const stored = {
          ...task,
          created_at: Date.now(),
          updated_at: Date.now(),
        };
        tasks.push(stored);
        return stored;
      }),
      getTask: vi.fn((_team: string, taskId: string) =>
        tasks.find((task) => task.id === taskId) as any,
      ),
      updateTask: vi.fn((_team: string, taskId: string, updates: Record<string, unknown>) => {
        const task = tasks.find((candidate) => candidate.id === taskId);
        if (!task) return null;
        Object.assign(task, updates, { updated_at: Date.now() });
        return task as any;
      }),
      save: vi.fn(async () => {}),
    } as unknown as TeamStores["runs"],
    messages: {
      save: vi.fn(async () => {}),
      push: vi.fn(),
    } as unknown as TeamStores["messages"],
    activity: {
      log: vi.fn(),
      save: vi.fn(async () => {}),
    } as unknown as TeamStores["activity"],
  };
}

function setTestRegistry(
  teamConfig: TeamConfig,
  stores: TeamStores,
  opts?: {
    memberSessions?: Map<string, Map<string, { sessionKey: string; runId: string; createdAt: number }>>;
    sessionIndex?: Map<string, { agentId: string; runId: string }>;
  },
) {
  const registry: PluginRegistry = {
    config: { teams: { dev: teamConfig } },
    teams: new Map([["dev", stores]]),
    memberSessions: opts?.memberSessions ?? new Map(),
    sessionIndex: opts?.sessionIndex ?? new Map(),
    invalidatedSessions: new Set(),
    getTeamStores: (team: string) => (team === "dev" ? stores : undefined),
    getTeamConfig: (team: string) => (team === "dev" ? teamConfig : undefined),
    enqueueSystemEvent: vi.fn(() => true),
    requestHeartbeatNow: vi.fn(),
  };
  setRegistry(registry);
}

describe("teamTaskTool", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects non-team agent task creation (team-only guard)", async () => {
    const teamConfig: TeamConfig = {
      description: "Orchestrator team",
      coordination: "orchestrator",
      orchestrator: "lead",
      members: {
        lead: { role: "Lead" },
        frontend: { role: "Frontend" },
      },
    };
    const stores = makeStores();
    setTestRegistry(teamConfig, stores);

    const tool = teamTaskTool({ agentId: "main" });
    const result = await tool.execute("test", {
      action: "create",
      team: "dev",
      description: "Build the UI",
      assign_to: "frontend",
    });

    const details = result.details as Record<string, unknown>;
    expect(details.error).toContain("team_task is for team agents only");
    expect(details.error).toContain("team_run(action: \"start\")");
  });

  it("includes task in spawn_action for inactive native assignees", async () => {
    const teamConfig: TeamConfig = {
      description: "Orchestrator team",
      coordination: "orchestrator",
      orchestrator: "lead",
      members: {
        lead: { role: "Lead" },
        frontend: { role: "Frontend" },
      },
    };
    const stores = makeStores();
    setTestRegistry(teamConfig, stores);

    const tool = teamTaskTool({
      agentId: "at--dev--lead",
      sessionKey: "agent:at--dev--lead:run:run-1",
    });
    const result = await tool.execute("test", {
      action: "create",
      description: "Build the UI shell and charts",
      assign_to: "frontend",
    });

    const details = result.details as Record<string, unknown>;
    expect(details.requires_session).toBe(true);
    expect(details.pending_activations).toBe(1);
    expect(details.REQUIRED_ACTION).toContain("sessions_send");
    expect(details.REQUIRED_ACTION).toContain("frontend");

    const registry = (await import("../src/registry.js")).getRegistry();
    // Notification sent to caller's session (orchestrator), not main agent
    expect(registry.enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("sessions_send"),
      { sessionKey: "agent:at--dev--lead:run:run-1" },
    );
  });

  it("sends activation notification to caller's session, not requester", async () => {
    const teamConfig: TeamConfig = {
      description: "Orchestrator team",
      coordination: "orchestrator",
      orchestrator: "lead",
      members: {
        lead: { role: "Lead" },
        frontend: { role: "Frontend" },
      },
    };
    const stores = makeStores();
    setTestRegistry(teamConfig, stores);

    const orchestratorSessionKey = "agent:at--dev--lead:run:run-1";
    const tool = teamTaskTool({
      agentId: "at--dev--lead",
      sessionKey: orchestratorSessionKey,
    });
    await tool.execute("test", {
      action: "create",
      description: "Build the UI shell",
      assign_to: "frontend",
    });

    const registry = (await import("../src/registry.js")).getRegistry();
    // Should send to orchestrator's session, NOT to main-agent-session
    const calls = (registry.enqueueSystemEvent as ReturnType<typeof vi.fn>).mock.calls;
    const activationCall = calls.find(
      (c: unknown[]) => typeof c[0] === "string" && c[0].includes("Action Required"),
    );
    expect(activationCall).toBeDefined();
    expect(activationCall![1]).toEqual({ sessionKey: orchestratorSessionKey });
  });

  it("rejects non-team agent task creation in peer mode (team-only guard)", async () => {
    const teamConfig: TeamConfig = {
      description: "Peer team",
      coordination: "peer",
      members: {
        alice: { role: "Alice" },
        bob: { role: "Bob" },
      },
    };
    const stores = makeStores();
    setTestRegistry(teamConfig, stores);

    const tool = teamTaskTool({ agentId: "main" });
    const result = await tool.execute("test", {
      action: "create",
      team: "dev",
      description: "Seed the peer backlog",
    });

    const details = result.details as Record<string, unknown>;
    expect(details.error).toContain("team_task is for team agents only");
    expect(details.error).toContain("team_run(action: \"start\")");
  });

  it("rejects __leader__ task update in orchestrator mode (team-only guard)", async () => {
    const teamConfig: TeamConfig = {
      description: "Orchestrator team",
      coordination: "orchestrator",
      orchestrator: "lead",
      members: { lead: { role: "Lead" }, worker: { role: "Worker" } },
    };
    const stores = makeStores({
      runs: {
        getTask: vi.fn(() => ({ id: "task-1", status: "WORKING", description: "test" })),
      } as unknown as TeamStores["runs"],
    });
    setTestRegistry(teamConfig, stores);

    const tool = teamTaskTool({ agentId: "main" });
    const result = await tool.execute("test", {
      action: "update",
      team: "dev",
      task_id: "task-1",
      status: "COMPLETED",
      result: "done",
    });

    const details = result.details as Record<string, unknown>;
    expect(details.error).toContain("team_task is for team agents only");
  });

  it("does not request another spawn when the native assignee is already active", async () => {
    const teamConfig: TeamConfig = {
      description: "Orchestrator team",
      coordination: "orchestrator",
      orchestrator: "lead",
      members: {
        lead: { role: "Lead" },
        frontend: { role: "Frontend" },
      },
    };
    const stores = makeStores();
    setTestRegistry(teamConfig, stores, {
      memberSessions: new Map([
        ["at--dev--frontend", new Map([
          ["run-1", { sessionKey: "agent:at--dev--frontend:run:run-1", runId: "run-1", createdAt: Date.now() }],
        ])],
      ]),
    });

    const tool = teamTaskTool({ agentId: "at--dev--lead" });
    const result = await tool.execute("test", {
      action: "create",
      description: "Build the UI shell",
      assign_to: "frontend",
    });

    const details = result.details as Record<string, unknown>;
    expect(details.requires_spawn).toBeUndefined();
    expect(details.spawn_action).toBeUndefined();
    expect(details.active_session).toBe(true);
  });

  it("rejects new peer self-assigned tasks when the caller already has active work", async () => {
    const teamConfig: TeamConfig = {
      description: "Peer team",
      coordination: "peer",
      members: {
        alice: { role: "Alice" },
        bob: { role: "Bob" },
      },
    };
    const stores = makeStores();
    stores.runs.addTask("dev", {
      id: "task-existing",
      team: "dev",
      run_id: "run-1",
      description: "Existing peer task",
      assigned_to: "alice",
      status: "WORKING",
    } as never);
    setTestRegistry(teamConfig, stores);

    const tool = teamTaskTool({ agentId: "at--dev--alice" });
    const result = await tool.execute("test", {
      action: "create",
      description: "Create another implementation task for myself",
    });

    const details = result.details as Record<string, unknown>;
    expect(details.error).toContain("Finish or update your active peer tasks before creating another task for yourself");
    expect(details.error).toContain('team_task(action: "query", filter: "mine")');
  });

  it("wakes an already-active native assignee when a task is created", async () => {
    const teamConfig: TeamConfig = {
      description: "Peer team",
      coordination: "peer",
      members: {
        alice: { role: "Alice" },
        bob: { role: "Bob" },
      },
    };
    const stores = makeStores();
    setTestRegistry(teamConfig, stores, {
      memberSessions: new Map([
        ["at--dev--bob", new Map([
          ["run-1", { sessionKey: "agent:at--dev--bob:subagent:1", runId: "run-1", createdAt: Date.now() }],
        ])],
      ]),
    });

    const tool = teamTaskTool({ agentId: "at--dev--alice" });
    await tool.execute("test", {
      action: "create",
      description: "Pick up the shared hooks task",
      assign_to: "bob",
    });

    const registry = (await import("../src/registry.js")).getRegistry();
    expect(registry.enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining('New team task assigned to you'),
      { sessionKey: "agent:at--dev--bob:subagent:1" },
    );
    expect(registry.requestHeartbeatNow).toHaveBeenCalledWith({
      agentId: "at--dev--bob",
      reason: "task-assigned",
      sessionKey: "agent:at--dev--bob:subagent:1",
    });
  });

  it("wakes an already-active native assignee when a dependency unblock makes their task available", async () => {
    const teamConfig: TeamConfig = {
      description: "Orchestrator team",
      coordination: "orchestrator",
      orchestrator: "lead",
      members: {
        lead: { role: "Lead" },
        backend: { role: "Backend" },
      },
    };
    const stores = makeStores();
    stores.runs.addTask("dev", {
      id: "task-backend",
      team: "dev",
      run_id: "run-1",
      description: "Build backend API",
      assigned_to: "backend",
      status: "WORKING",
    } as never);
    stores.runs.addTask("dev", {
      id: "task-lead",
      team: "dev",
      run_id: "run-1",
      description: "Integrate final handoff",
      assigned_to: "lead",
      status: "BLOCKED",
      depends_on: ["task-backend"],
    } as never);
    setTestRegistry(teamConfig, stores, {
      memberSessions: new Map([
        ["at--dev--lead", new Map([
          ["run-1", { sessionKey: "agent:at--dev--lead:subagent:1", runId: "run-1", createdAt: Date.now() }],
        ])],
      ]),
    });

    const tool = teamTaskTool({ agentId: "at--dev--backend" });
    await tool.execute("test", {
      action: "update",
      task_id: "task-backend",
      status: "COMPLETED",
      result: "Backend done",
    });

    const leadTask = stores.runs.getTask("dev", "task-lead");
    expect(leadTask?.status).toBe("WORKING");

    const registry = (await import("../src/registry.js")).getRegistry();
    expect(registry.enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("New team task assigned to you: task-lead"),
      { sessionKey: "agent:at--dev--lead:subagent:1" },
    );
    expect(registry.requestHeartbeatNow).toHaveBeenCalledWith({
      agentId: "at--dev--lead",
      reason: "task-assigned",
      sessionKey: "agent:at--dev--lead:subagent:1",
    });
  });

  it("sends all-tasks-terminal notification to orchestrator session, not main agent", async () => {
    const teamConfig: TeamConfig = {
      description: "Orchestrator team",
      coordination: "orchestrator",
      orchestrator: "lead",
      members: {
        lead: { role: "Lead" },
        worker: { role: "Worker" },
      },
    };
    const tasks: Array<Record<string, unknown>> = [];
    const stores: TeamStores = {
      kv: {
        set: vi.fn(),
        save: vi.fn(async () => {}),
        *iterEntries() {},
      } as unknown as TeamStores["kv"],
      events: {
        save: vi.fn(async () => {}),
      } as unknown as TeamStores["events"],
      docs: {} as TeamStores["docs"],
      runs: {
        getRun: vi.fn(() => ({
          found: true,
          run: { id: "run-1", status: "WORKING", tasks, requester_session: "main-agent-session" },
        })),
        listTasks: vi.fn(() => tasks as any),
        addTask: vi.fn((_team: string, task: Record<string, unknown>) => {
          const stored = { ...task, created_at: Date.now(), updated_at: Date.now() };
          tasks.push(stored);
          return stored;
        }),
        getTask: vi.fn((_team: string, taskId: string) =>
          tasks.find((t) => t.id === taskId) as any,
        ),
        updateTask: vi.fn((_team: string, taskId: string, updates: Record<string, unknown>) => {
          const task = tasks.find((c) => c.id === taskId);
          if (!task) return null;
          Object.assign(task, updates, { updated_at: Date.now() });
          return task as any;
        }),
        save: vi.fn(async () => {}),
      } as unknown as TeamStores["runs"],
      messages: {
        save: vi.fn(async () => {}),
        push: vi.fn(),
      } as unknown as TeamStores["messages"],
      activity: {
        log: vi.fn(),
        save: vi.fn(async () => {}),
      } as unknown as TeamStores["activity"],
    };
    // Add a single task that's WORKING
    stores.runs.addTask("dev", {
      id: "task-1",
      team: "dev",
      run_id: "run-1",
      description: "Do the work",
      assigned_to: "worker",
      status: "WORKING",
    } as never);
    setTestRegistry(teamConfig, stores);

    const tool = teamTaskTool({ agentId: "at--dev--worker", sessionKey: "agent:at--dev--worker:run:run-1" });
    await tool.execute("test", {
      action: "update",
      task_id: "task-1",
      status: "COMPLETED",
      result: "Done",
    });

    const registry = (await import("../src/registry.js")).getRegistry();
    // Should send completion notification to orchestrator's session
    const orchSk = "agent:at--dev--lead:run:run-1";
    const calls = (registry.enqueueSystemEvent as ReturnType<typeof vi.fn>).mock.calls;
    const completionCall = calls.find(
      (c: unknown[]) => typeof c[0] === "string" && c[0].includes("Action Required") && c[0].includes("Complete the run"),
    );
    expect(completionCall).toBeDefined();
    expect(completionCall![1]).toEqual({ sessionKey: orchSk });
  });

  it("pushes progress summary to main agent on task completion", async () => {
    const teamConfig: TeamConfig = {
      description: "Orchestrator team",
      coordination: "orchestrator",
      orchestrator: "lead",
      members: {
        lead: { role: "Lead" },
        backend: { role: "Backend" },
        frontend: { role: "Frontend" },
      },
    };
    const stores = makeStores();
    stores.runs.addTask("dev", {
      id: "task-1",
      team: "dev",
      run_id: "run-1",
      description: "Build backend API",
      assigned_to: "backend",
      status: "WORKING",
    } as never);
    stores.runs.addTask("dev", {
      id: "task-2",
      team: "dev",
      run_id: "run-1",
      description: "Build frontend UI",
      assigned_to: "frontend",
      status: "PENDING",
    } as never);
    setTestRegistry(teamConfig, stores);

    const tool = teamTaskTool({ agentId: "at--dev--backend", sessionKey: "agent:at--dev--backend:run:run-1" });
    await tool.execute("test", {
      action: "update",
      task_id: "task-1",
      status: "COMPLETED",
      result: "API done",
    });

    const registry = (await import("../src/registry.js")).getRegistry();
    const calls = (registry.enqueueSystemEvent as ReturnType<typeof vi.fn>).mock.calls;
    // Progress push should go to main agent (requester_session)
    const progressCall = calls.find(
      (c: unknown[]) => typeof c[0] === "string" && c[0].includes("Progress:") && c[0].includes("completed"),
    );
    expect(progressCall).toBeDefined();
    expect(progressCall![1]).toEqual({ sessionKey: "main-agent-session" });
  });

  it("pushes progress summary to main agent on task failure", async () => {
    const teamConfig: TeamConfig = {
      description: "Orchestrator team",
      coordination: "orchestrator",
      orchestrator: "lead",
      members: {
        lead: { role: "Lead" },
        worker: { role: "Worker" },
      },
    };
    const stores = makeStores();
    stores.runs.addTask("dev", {
      id: "task-1",
      team: "dev",
      run_id: "run-1",
      description: "Risky operation",
      assigned_to: "worker",
      status: "WORKING",
    } as never);
    setTestRegistry(teamConfig, stores);

    const tool = teamTaskTool({ agentId: "at--dev--worker", sessionKey: "agent:at--dev--worker:run:run-1" });
    await tool.execute("test", {
      action: "update",
      task_id: "task-1",
      status: "FAILED",
      message: "Something went wrong",
    });

    const registry = (await import("../src/registry.js")).getRegistry();
    const calls = (registry.enqueueSystemEvent as ReturnType<typeof vi.fn>).mock.calls;
    const progressCall = calls.find(
      (c: unknown[]) => typeof c[0] === "string" && c[0].includes("Task failed"),
    );
    expect(progressCall).toBeDefined();
    // Should include "failed" in the progress message
    expect(progressCall![0]).toContain("failed");
  });

  it("rejects completing a task when its dependencies are still unresolved", async () => {
    const teamConfig: TeamConfig = {
      description: "Orchestrator team",
      coordination: "orchestrator",
      orchestrator: "lead",
      members: {
        lead: { role: "Lead" },
        backend: { role: "Backend" },
        frontend: { role: "Frontend" },
      },
    };
    const stores = makeStores();
    stores.runs.addTask("dev", {
      id: "task-backend",
      team: "dev",
      run_id: "run-1",
      description: "Build backend API",
      assigned_to: "backend",
      status: "WORKING",
    } as never);
    stores.runs.addTask("dev", {
      id: "task-frontend",
      team: "dev",
      run_id: "run-1",
      description: "Integrate frontend with backend",
      assigned_to: "frontend",
      status: "WORKING",
      depends_on: ["task-backend"],
    } as never);
    setTestRegistry(teamConfig, stores);

    const tool = teamTaskTool({ agentId: "at--dev--frontend" });
    const result = await tool.execute("test", {
      action: "update",
      task_id: "task-frontend",
      status: "COMPLETED",
      result: "Frontend done",
    });

    const details = result.details as Record<string, unknown>;
    expect(details.error).toContain("Cannot move task forward while dependencies are unresolved");
    expect(details.error).toContain("task-backend");
  });
});

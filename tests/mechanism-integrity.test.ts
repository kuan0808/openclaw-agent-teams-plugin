/**
 * Tests for mechanism integrity fixes:
 * - 1A: Peer auto-complete via shouldAutoComplete()
 * - 1B: Cascade cancel dependents via cascadeCancelDependents()
 * - 1C: Lazy timeout & max_rounds enforcement
 * - 1D: Native subagent crash → task state
 * - 1E: archiveRun() session cleanup
 * - 1F: Run cancellation per-task activity logging
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/tools/cli-spawn-helper.js", () => ({
  spawnCliIfNeeded: vi.fn(async () => {}),
}));

import { setRegistry } from "../src/registry.js";
import { teamTaskTool } from "../src/tools/team-task.js";
import { teamRunTool } from "../src/tools/team-run.js";
import { createSubagentEndedHook } from "../src/hooks/subagent-lifecycle.js";
import { checkRunLimits } from "../src/enforcement.js";
import type { PluginRegistry, TeamStores } from "../src/registry.js";
import type { TeamConfig, TeamRun, TeamTask, RunSession } from "../src/types.js";

// ── Helpers ───────────────────────────────────────────────────────────

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
      getRun: vi.fn((_team: string, runId?: string) => {
        if (runId === "run-1" || !runId) {
          return {
            found: true,
            run: {
              id: "run-1",
              team: "dev",
              goal: "Test goal",
              status: "WORKING",
              tasks,
              started_at: Date.now(),
              updated_at: Date.now(),
            } as TeamRun,
          };
        }
        return { found: false };
      }),
      listTasks: vi.fn((_team: string, _filter?: string[], _runId?: string) => tasks as any),
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
      completeRun: vi.fn(),
      cancelRun: vi.fn(() => ({ ok: true, status: "CANCELED", tasks_canceled: 0 })),
      archiveRun: vi.fn(async () => {}),
      incrementRoundCount: vi.fn(() => 1),
      save: vi.fn(async () => {}),
      listRuns: vi.fn(() => []),
      getWorkingRuns: vi.fn(() => []),
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
    memberSessions?: Map<string, Map<string, RunSession>>;
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
  return registry;
}

// ── 1A: Peer Auto-Complete ─────────────────────────────────────────────

describe("1A: Peer auto-complete", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("auto-completes a peer run when all tasks reach COMPLETED", async () => {
    const teamConfig: TeamConfig = {
      description: "Peer team",
      coordination: "peer",
      members: {
        alice: { role: "Dev" },
        bob: { role: "Dev" },
      },
    };
    const stores = makeStores();
    // Add a task already in WORKING
    stores.runs.addTask("dev", {
      id: "task-1",
      team: "dev",
      run_id: "run-1",
      description: "Do work",
      assigned_to: "alice",
      status: "WORKING",
    } as never);
    setTestRegistry(teamConfig, stores);

    const tool = teamTaskTool({ agentId: "at--dev--alice" });
    await tool.execute("test", {
      action: "update",
      task_id: "task-1",
      status: "COMPLETED",
      result: "Done",
    });

    expect(stores.runs.completeRun).toHaveBeenCalledWith(
      "dev",
      "All tasks completed",
      "run-1",
    );
    expect(stores.activity.log).toHaveBeenCalledWith(
      "dev", "alice", "run_completed",
      expect.stringContaining("Auto-completed"),
      expect.objectContaining({ metadata: expect.objectContaining({ auto_complete: true }) }),
    );
  });

  it("auto-completes with mixed terminal states (COMPLETED + FAILED)", async () => {
    const teamConfig: TeamConfig = {
      description: "Peer team",
      coordination: "peer",
      members: {
        alice: { role: "Dev" },
        bob: { role: "Dev" },
      },
    };
    const stores = makeStores();
    stores.runs.addTask("dev", {
      id: "task-1",
      team: "dev",
      run_id: "run-1",
      description: "Failed work",
      assigned_to: "alice",
      status: "FAILED",
      message: "Something broke",
    } as never);
    stores.runs.addTask("dev", {
      id: "task-2",
      team: "dev",
      run_id: "run-1",
      description: "Last task",
      assigned_to: "bob",
      status: "WORKING",
    } as never);
    setTestRegistry(teamConfig, stores);

    const tool = teamTaskTool({ agentId: "at--dev--bob" });
    await tool.execute("test", {
      action: "update",
      task_id: "task-2",
      status: "COMPLETED",
      result: "Done",
    });

    expect(stores.runs.completeRun).toHaveBeenCalledWith(
      "dev",
      "All tasks reached terminal state",
      "run-1",
    );
  });

  it("does NOT auto-complete when non-terminal tasks remain", async () => {
    const teamConfig: TeamConfig = {
      description: "Peer team",
      coordination: "peer",
      members: {
        alice: { role: "Dev" },
        bob: { role: "Dev" },
      },
    };
    const stores = makeStores();
    stores.runs.addTask("dev", {
      id: "task-1",
      team: "dev",
      run_id: "run-1",
      description: "Done task",
      assigned_to: "alice",
      status: "WORKING",
    } as never);
    stores.runs.addTask("dev", {
      id: "task-2",
      team: "dev",
      run_id: "run-1",
      description: "Still pending",
      assigned_to: "bob",
      status: "PENDING",
    } as never);
    setTestRegistry(teamConfig, stores);

    const tool = teamTaskTool({ agentId: "at--dev--alice" });
    await tool.execute("test", {
      action: "update",
      task_id: "task-1",
      status: "COMPLETED",
      result: "Done",
    });

    expect(stores.runs.completeRun).not.toHaveBeenCalled();
  });

  it("records all_terminal_at and returns REQUIRED_ACTION in orchestrator mode (not immediate auto-complete)", async () => {
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
      description: "Do work",
      assigned_to: "worker",
      status: "WORKING",
    } as never);
    setTestRegistry(teamConfig, stores);

    const tool = teamTaskTool({ agentId: "at--dev--worker", sessionKey: "agent:at--dev--worker:run:run-1" });
    const toolResult = await tool.execute("test", {
      action: "update",
      task_id: "task-1",
      status: "COMPLETED",
      result: "Done",
    });

    // Should NOT immediately auto-complete (orchestrator gets grace period)
    expect(stores.runs.completeRun).not.toHaveBeenCalled();
    // Should return REQUIRED_ACTION telling worker to notify orchestrator
    const details = toolResult.details as Record<string, unknown>;
    expect(details.REQUIRED_ACTION).toBeDefined();
    expect(details.REQUIRED_ACTION).toContain("sessions_send");
    expect(details.REQUIRED_ACTION).toContain("orchestrator");
  });
});

// ── 1B: Cascade Cancel Dependents ──────────────────────────────────────

describe("1B: Cascade cancel on task failure", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("cascade-cancels dependent tasks when a task fails", async () => {
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
      id: "task-upstream",
      team: "dev",
      run_id: "run-1",
      description: "Upstream work",
      assigned_to: "worker",
      status: "WORKING",
    } as never);
    stores.runs.addTask("dev", {
      id: "task-downstream",
      team: "dev",
      run_id: "run-1",
      description: "Downstream blocked",
      assigned_to: "worker",
      status: "BLOCKED",
      depends_on: ["task-upstream"],
    } as never);
    setTestRegistry(teamConfig, stores);

    const tool = teamTaskTool({ agentId: "at--dev--worker" });
    await tool.execute("test", {
      action: "update",
      task_id: "task-upstream",
      status: "FAILED",
      message: "Build error",
    });

    // The downstream task should have been cascade-canceled (in-place mutation)
    const downstream = stores.runs.getTask("dev", "task-downstream");
    expect(downstream?.status).toBe("CANCELED");
    expect(downstream?.message).toContain("Cascade-canceled");

    // Activity log should record the cascade
    expect(stores.activity.log).toHaveBeenCalledWith(
      "dev", "worker", "dependency_cascaded",
      expect.stringContaining("Cascade-canceled"),
      expect.objectContaining({ target_id: "task-downstream" }),
    );
  });

  it("does NOT cascade-cancel when task is completed", async () => {
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
      id: "task-upstream",
      team: "dev",
      run_id: "run-1",
      description: "Upstream work",
      assigned_to: "worker",
      status: "WORKING",
    } as never);
    stores.runs.addTask("dev", {
      id: "task-downstream",
      team: "dev",
      run_id: "run-1",
      description: "Downstream blocked",
      assigned_to: "worker",
      status: "BLOCKED",
      depends_on: ["task-upstream"],
    } as never);
    setTestRegistry(teamConfig, stores);

    const tool = teamTaskTool({ agentId: "at--dev--worker" });
    await tool.execute("test", {
      action: "update",
      task_id: "task-upstream",
      status: "COMPLETED",
      result: "Done",
    });

    // Downstream should be unblocked, not canceled
    const downstream = stores.runs.getTask("dev", "task-downstream");
    expect(downstream?.status).toBe("PENDING");
  });

  it("handles transitive cascade (A → B → C)", async () => {
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
      id: "task-a",
      team: "dev",
      run_id: "run-1",
      description: "Root task",
      assigned_to: "worker",
      status: "WORKING",
    } as never);
    stores.runs.addTask("dev", {
      id: "task-b",
      team: "dev",
      run_id: "run-1",
      description: "Middle task",
      assigned_to: "worker",
      status: "BLOCKED",
      depends_on: ["task-a"],
    } as never);
    stores.runs.addTask("dev", {
      id: "task-c",
      team: "dev",
      run_id: "run-1",
      description: "Leaf task",
      assigned_to: "worker",
      status: "BLOCKED",
      depends_on: ["task-b"],
    } as never);
    setTestRegistry(teamConfig, stores);

    const tool = teamTaskTool({ agentId: "at--dev--worker" });
    await tool.execute("test", {
      action: "update",
      task_id: "task-a",
      status: "FAILED",
      message: "Root failure",
    });

    expect(stores.runs.getTask("dev", "task-b")?.status).toBe("CANCELED");
    expect(stores.runs.getTask("dev", "task-c")?.status).toBe("CANCELED");
  });
});

// ── 1C: Lazy Enforcement ───────────────────────────────────────────────

describe("1C: checkRunLimits", () => {
  it("returns timeout violation when elapsed exceeds timeout", () => {
    const run: TeamRun = {
      id: "run-1",
      team: "dev",
      goal: "Test",
      status: "WORKING",
      tasks: [],
      started_at: Date.now() - 700_000, // 700s ago
      updated_at: Date.now(),
    };
    const config: TeamConfig = {
      description: "Test",
      coordination: "peer",
      members: { alice: { role: "Dev" } },
      workflow: { timeout: 600 },
    };

    const violation = checkRunLimits(run, config);
    expect(violation).not.toBeNull();
    expect(violation!.type).toBe("timeout");
    expect(violation!.message).toContain("exceeded timeout");
  });

  it("returns max_rounds violation when rounds exceed limit", () => {
    const run: TeamRun = {
      id: "run-1",
      team: "dev",
      goal: "Test",
      status: "WORKING",
      tasks: [],
      started_at: Date.now(),
      updated_at: Date.now(),
      round_count: 10,
    };
    const config: TeamConfig = {
      description: "Test",
      coordination: "peer",
      members: { alice: { role: "Dev" } },
      workflow: { max_rounds: 10 },
    };

    const violation = checkRunLimits(run, config);
    expect(violation).not.toBeNull();
    expect(violation!.type).toBe("max_rounds");
    expect(violation!.message).toContain("exceeded max rounds");
  });

  it("returns null when within limits", () => {
    const run: TeamRun = {
      id: "run-1",
      team: "dev",
      goal: "Test",
      status: "WORKING",
      tasks: [],
      started_at: Date.now() - 100_000, // 100s ago
      updated_at: Date.now(),
      round_count: 3,
    };
    const config: TeamConfig = {
      description: "Test",
      coordination: "peer",
      members: { alice: { role: "Dev" } },
      workflow: { timeout: 600, max_rounds: 10 },
    };

    expect(checkRunLimits(run, config)).toBeNull();
  });

  it("skips check for non-WORKING runs", () => {
    const run: TeamRun = {
      id: "run-1",
      team: "dev",
      goal: "Test",
      status: "COMPLETED",
      tasks: [],
      started_at: Date.now() - 700_000,
      updated_at: Date.now(),
    };
    const config: TeamConfig = {
      description: "Test",
      coordination: "peer",
      members: { alice: { role: "Dev" } },
      workflow: { timeout: 600 },
    };

    expect(checkRunLimits(run, config)).toBeNull();
  });

  it("skips check when no workflow config", () => {
    const run: TeamRun = {
      id: "run-1",
      team: "dev",
      goal: "Test",
      status: "WORKING",
      tasks: [],
      started_at: Date.now() - 700_000,
      updated_at: Date.now(),
    };
    const config: TeamConfig = {
      description: "Test",
      coordination: "peer",
      members: { alice: { role: "Dev" } },
    };

    expect(checkRunLimits(run, config)).toBeNull();
  });
});

describe("1C: Enforcement integration in team_task", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("auto-cancels run on timeout and returns error", async () => {
    const teamConfig: TeamConfig = {
      description: "Peer team",
      coordination: "peer",
      members: { alice: { role: "Dev" } },
      workflow: { timeout: 60 },
    };
    const stores = makeStores();
    // Override getRun to return a timed-out run
    (stores.runs.getRun as ReturnType<typeof vi.fn>).mockReturnValue({
      found: true,
      run: {
        id: "run-1",
        team: "dev",
        goal: "Test",
        status: "WORKING",
        tasks: [],
        started_at: Date.now() - 120_000, // 120s ago, timeout is 60s
        updated_at: Date.now(),
      } as TeamRun,
    });
    setTestRegistry(teamConfig, stores);

    const tool = teamTaskTool({ agentId: "at--dev--alice", sessionKey: "agent:at--dev--alice:run:run-1" });
    const result = await tool.execute("test", {
      action: "create",
      description: "New task",
    });

    const details = result.details as Record<string, unknown>;
    expect(details.error).toContain("Run canceled");
    expect(details.error).toContain("exceeded timeout");
    expect(stores.runs.cancelRun).toHaveBeenCalled();
    expect(stores.activity.log).toHaveBeenCalledWith(
      "dev", "alice", "run_timeout",
      expect.any(String),
      expect.any(Object),
    );
  });
});

// ── 1D: Native Subagent Crash → Task State ─────────────────────────────

describe("1D: Native subagent crash fails orphaned tasks", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("fails WORKING tasks when native subagent session ends", async () => {
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
    // Add a WORKING task for the worker
    stores.runs.addTask("dev", {
      id: "task-in-progress",
      team: "dev",
      run_id: "run-1",
      description: "In-progress task",
      assigned_to: "worker",
      status: "WORKING",
    } as never);

    const memberSessions = new Map<string, Map<string, RunSession>>();
    const workerSessions = new Map<string, RunSession>();
    workerSessions.set("run-1", {
      sessionKey: "agent:at--dev--worker:run:run-1",
      runId: "run-1",
      createdAt: Date.now(),
    });
    memberSessions.set("at--dev--worker", workerSessions);

    const sessionIndex = new Map<string, { agentId: string; runId: string }>();
    sessionIndex.set("agent:at--dev--worker:run:run-1", {
      agentId: "at--dev--worker",
      runId: "run-1",
    });

    setTestRegistry(teamConfig, stores, { memberSessions, sessionIndex });

    const hook = createSubagentEndedHook();
    await hook(
      { targetSessionKey: "agent:at--dev--worker:run:run-1" },
      {},
    );

    // The task should now be FAILED
    expect(stores.runs.updateTask).toHaveBeenCalledWith(
      "dev",
      "task-in-progress",
      expect.objectContaining({
        status: "FAILED",
        message: "Agent session ended while task was in progress",
      }),
    );

    expect(stores.activity.log).toHaveBeenCalledWith(
      "dev", "worker", "task_failed",
      expect.stringContaining("agent session ended"),
      expect.objectContaining({ target_id: "task-in-progress" }),
    );
  });

  it("does not fail COMPLETED tasks when session ends", async () => {
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
      id: "task-done",
      team: "dev",
      run_id: "run-1",
      description: "Completed task",
      assigned_to: "worker",
      status: "COMPLETED",
      result: "Done",
    } as never);

    const memberSessions = new Map<string, Map<string, RunSession>>();
    const workerSessions = new Map<string, RunSession>();
    workerSessions.set("run-1", {
      sessionKey: "agent:at--dev--worker:run:run-1",
      runId: "run-1",
      createdAt: Date.now(),
    });
    memberSessions.set("at--dev--worker", workerSessions);

    setTestRegistry(teamConfig, stores, { memberSessions });

    const hook = createSubagentEndedHook();
    await hook(
      { targetSessionKey: "agent:at--dev--worker:run:run-1" },
      {},
    );

    // updateTask should NOT have been called (no WORKING tasks to fail)
    expect(stores.runs.updateTask).not.toHaveBeenCalled();
  });
});

// ── 1E: archiveRun Session Cleanup ─────────────────────────────────────

describe("1E: Session cleanup on run complete/cancel", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("cleans up session registry on run completion", async () => {
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
    (stores.runs.completeRun as ReturnType<typeof vi.fn>).mockReturnValue({
      ok: true,
      status: "COMPLETED",
    });

    const memberSessions = new Map<string, Map<string, RunSession>>();
    const workerSessions = new Map<string, RunSession>();
    workerSessions.set("run-1", {
      sessionKey: "agent:at--dev--worker:run:run-1",
      runId: "run-1",
      createdAt: Date.now(),
    });
    memberSessions.set("at--dev--worker", workerSessions);

    const sessionIndex = new Map<string, { agentId: string; runId: string }>();
    sessionIndex.set("agent:at--dev--worker:run:run-1", {
      agentId: "at--dev--worker",
      runId: "run-1",
    });

    const registry = setTestRegistry(teamConfig, stores, { memberSessions, sessionIndex });

    const tool = teamRunTool({ agentId: "at--dev--lead", sessionKey: "agent:at--dev--lead:run:run-1" });
    await tool.execute("test", {
      action: "complete",
      result: "All done",
    });

    // Session entries should be cleaned up
    expect(registry.memberSessions.has("at--dev--worker")).toBe(false);
    expect(registry.sessionIndex.has("agent:at--dev--worker:run:run-1")).toBe(false);
  });

  it("cleans up session registry on run cancellation", async () => {
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
    (stores.runs.cancelRun as ReturnType<typeof vi.fn>).mockReturnValue({
      ok: true,
      status: "CANCELED",
      tasks_canceled: 1,
    });

    const memberSessions = new Map<string, Map<string, RunSession>>();
    const workerSessions = new Map<string, RunSession>();
    workerSessions.set("run-1", {
      sessionKey: "agent:at--dev--worker:run:run-1",
      runId: "run-1",
      createdAt: Date.now(),
    });
    memberSessions.set("at--dev--worker", workerSessions);

    const sessionIndex = new Map<string, { agentId: string; runId: string }>();
    sessionIndex.set("agent:at--dev--worker:run:run-1", {
      agentId: "at--dev--worker",
      runId: "run-1",
    });

    const registry = setTestRegistry(teamConfig, stores, { memberSessions, sessionIndex });

    const tool = teamRunTool({ agentId: "main" });
    await tool.execute("test", {
      action: "cancel",
      team: "dev",
      run_id: "run-1",
      reason: "No longer needed",
    });

    expect(registry.memberSessions.has("at--dev--worker")).toBe(false);
    expect(registry.sessionIndex.has("agent:at--dev--worker:run:run-1")).toBe(false);
  });
});

// ── 1G: Revision Mechanism Integrity ─────────────────────────────────

describe("1G: Revision mechanism integrity", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("revision_count increments on REVISION_REQUESTED", async () => {
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
      description: "Do work",
      assigned_to: "worker",
      status: "COMPLETED",
      result: "Draft",
    } as never);
    setTestRegistry(teamConfig, stores);

    const tool = teamTaskTool({ agentId: "at--dev--lead", sessionKey: "agent:at--dev--lead:run:run-1" });
    const result = await tool.execute("test", {
      action: "update",
      task_id: "task-1",
      status: "REVISION_REQUESTED",
      message: "Needs more detail",
    });

    const details = result.details as Record<string, unknown>;
    expect(details.status).toBe("REVISION_REQUESTED");
    expect(details.revision_count).toBe(1);

    const task = stores.runs.getTask("dev", "task-1") as any;
    expect(task.revision_count).toBe(1);
    expect(task.revision_feedback).toBe("Needs more detail");
  });

  it("round_count increments on revision request", async () => {
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
      description: "Do work",
      assigned_to: "worker",
      status: "COMPLETED",
      result: "Draft",
    } as never);
    const reg = setTestRegistry(teamConfig, stores);

    // Access the run to check round_count later
    const runBefore = stores.runs.getRun("dev", "run-1");
    expect(runBefore.found && (runBefore.run.round_count ?? 0)).toBe(0);

    const tool = teamTaskTool({ agentId: "at--dev--lead", sessionKey: "agent:at--dev--lead:run:run-1" });
    await tool.execute("test", {
      action: "update",
      task_id: "task-1",
      status: "REVISION_REQUESTED",
      message: "Needs improvement",
    });

    // incrementRoundCount was called
    expect(stores.runs.incrementRoundCount).toHaveBeenCalledWith("dev", "run-1");
  });

  it("all_terminal_at resets on revision request", async () => {
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
      description: "Do work",
      assigned_to: "worker",
      status: "COMPLETED",
      result: "Done",
    } as never);
    const reg = setTestRegistry(teamConfig, stores);

    // Set all_terminal_at on the run
    const run = stores.runs.getRun("dev", "run-1");
    if (run.found) {
      run.run.all_terminal_at = Date.now();
    }

    const tool = teamTaskTool({ agentId: "at--dev--lead", sessionKey: "agent:at--dev--lead:run:run-1" });
    await tool.execute("test", {
      action: "update",
      task_id: "task-1",
      status: "REVISION_REQUESTED",
      message: "Not good enough",
    });

    // all_terminal_at should be reset
    const runAfter = stores.runs.getRun("dev", "run-1");
    if (runAfter.found) {
      expect(runAfter.run.all_terminal_at).toBeUndefined();
    }
  });
});

// ── 1F: Run Cancellation Activity Logging ──────────────────────────────

describe("1F: Per-task activity logging on run cancellation", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("logs individual task_canceled events when a run is canceled", async () => {
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
      description: "Task one",
      assigned_to: "worker",
      status: "CANCELED",
    } as never);
    stores.runs.addTask("dev", {
      id: "task-2",
      team: "dev",
      run_id: "run-1",
      description: "Task two",
      assigned_to: "worker",
      status: "CANCELED",
    } as never);

    (stores.runs.cancelRun as ReturnType<typeof vi.fn>).mockReturnValue({
      ok: true,
      status: "CANCELED",
      tasks_canceled: 2,
    });

    setTestRegistry(teamConfig, stores);

    const tool = teamRunTool({ agentId: "main" });
    await tool.execute("test", {
      action: "cancel",
      team: "dev",
      reason: "No longer needed",
    });

    // Should have task_canceled for each task
    const activityCalls = (stores.activity.log as ReturnType<typeof vi.fn>).mock.calls;
    const taskCanceledCalls = activityCalls.filter(
      (call: unknown[]) => call[2] === "task_canceled",
    );
    expect(taskCanceledCalls).toHaveLength(2);
    expect(taskCanceledCalls[0][4].target_id).toBe("task-1");
    expect(taskCanceledCalls[1][4].target_id).toBe("task-2");
  });
});

/**
 * Tests for the orchestrator review/rejection mechanism.
 *
 * REVISION_REQUESTED state allows orchestrators to review completed tasks
 * and send them back for revision with feedback.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/tools/cli-spawn-helper.js", () => ({
  spawnCliIfNeeded: vi.fn(async () => {}),
}));

import { spawnCliIfNeeded } from "../src/tools/cli-spawn-helper.js";
import { setRegistry } from "../src/registry.js";
import { teamTaskTool } from "../src/tools/team-task.js";
import { validateTransition, TERMINAL_TASK_STATES, ACTIVE_TASK_STATES } from "../src/state/run-manager.js";
import type { PluginRegistry, TeamStores } from "../src/registry.js";
import type { TeamConfig, TeamRun, TeamTask, RunSession, TaskState } from "../src/types.js";

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
    getTeamStores: (team: string) => (team === "dev" ? stores : undefined),
    getTeamConfig: (team: string) => (team === "dev" ? teamConfig : undefined),
    enqueueSystemEvent: vi.fn(() => true),
    requestHeartbeatNow: vi.fn(),
  };
  setRegistry(registry);
  return registry;
}

const orchestratorTeamConfig: TeamConfig = {
  description: "Orchestrator team",
  coordination: "orchestrator",
  orchestrator: "lead",
  members: {
    lead: { role: "Lead" },
    worker: { role: "Worker" },
    worker2: { role: "Worker 2" },
  },
};

// ── Core State Transitions ──────────────────────────────────────────────

describe("REVISION_REQUESTED state transitions", () => {
  it("COMPLETED → REVISION_REQUESTED is valid", () => {
    expect(validateTransition("COMPLETED", "REVISION_REQUESTED")).toBeNull();
  });

  it("REVISION_REQUESTED → WORKING is valid", () => {
    expect(validateTransition("REVISION_REQUESTED", "WORKING")).toBeNull();
  });

  it("REVISION_REQUESTED → CANCELED is valid", () => {
    expect(validateTransition("REVISION_REQUESTED", "CANCELED")).toBeNull();
  });

  it("REVISION_REQUESTED → COMPLETED is invalid", () => {
    const err = validateTransition("REVISION_REQUESTED", "COMPLETED");
    expect(err).toBeTypeOf("string");
  });

  it("REVISION_REQUESTED is in ACTIVE_TASK_STATES", () => {
    expect(ACTIVE_TASK_STATES.has("REVISION_REQUESTED")).toBe(true);
  });

  it("REVISION_REQUESTED is NOT in TERMINAL_TASK_STATES", () => {
    expect(TERMINAL_TASK_STATES.has("REVISION_REQUESTED")).toBe(false);
  });
});

// ── Orchestrator Review Flow ──────────────────────────────────────────

describe("Orchestrator review/rejection flow", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("orchestrator can request revision on COMPLETED task", async () => {
    const stores = makeStores();
    stores.runs.addTask("dev", {
      id: "task-1",
      team: "dev",
      run_id: "run-1",
      description: "Build feature",
      assigned_to: "worker",
      status: "COMPLETED",
      result: "Done",
    } as never);
    setTestRegistry(orchestratorTeamConfig, stores);

    const tool = teamTaskTool({ agentId: "at--dev--lead", sessionKey: "agent:at--dev--lead:run:run-1" });
    const result = await tool.execute("test", {
      action: "update",
      task_id: "task-1",
      status: "REVISION_REQUESTED",
      message: "Missing error handling. Add try/catch blocks.",
    });

    const details = result.details as Record<string, unknown>;
    expect(details.status).toBe("REVISION_REQUESTED");
    expect(details.revision_count).toBe(1);
    expect(details.feedback).toBe("Missing error handling. Add try/catch blocks.");
  });

  it("non-orchestrator blocked from requesting revision", async () => {
    const stores = makeStores();
    stores.runs.addTask("dev", {
      id: "task-1",
      team: "dev",
      run_id: "run-1",
      description: "Build feature",
      assigned_to: "worker",
      status: "COMPLETED",
      result: "Done",
    } as never);
    setTestRegistry(orchestratorTeamConfig, stores);

    const tool = teamTaskTool({ agentId: "at--dev--worker", sessionKey: "agent:at--dev--worker:run:run-1" });
    const result = await tool.execute("test", {
      action: "update",
      task_id: "task-1",
      status: "REVISION_REQUESTED",
      message: "Feedback",
    });

    const details = result.details as Record<string, unknown>;
    expect(details.error).toContain("Only");
    expect(details.error).toContain("lead");
  });

  it("feedback message is required", async () => {
    const stores = makeStores();
    stores.runs.addTask("dev", {
      id: "task-1",
      team: "dev",
      run_id: "run-1",
      description: "Build feature",
      assigned_to: "worker",
      status: "COMPLETED",
      result: "Done",
    } as never);
    setTestRegistry(orchestratorTeamConfig, stores);

    const tool = teamTaskTool({ agentId: "at--dev--lead", sessionKey: "agent:at--dev--lead:run:run-1" });
    const result = await tool.execute("test", {
      action: "update",
      task_id: "task-1",
      status: "REVISION_REQUESTED",
    });

    const details = result.details as Record<string, unknown>;
    expect(details.error).toContain("feedback is required");
  });

  it("worker can resubmit COMPLETED after revision", async () => {
    const stores = makeStores();
    stores.runs.addTask("dev", {
      id: "task-1",
      team: "dev",
      run_id: "run-1",
      description: "Build feature",
      assigned_to: "worker",
      status: "REVISION_REQUESTED",
      revision_count: 1,
      revision_feedback: "Add tests",
    } as never);
    setTestRegistry(orchestratorTeamConfig, stores);

    // Worker transitions to WORKING
    const tool = teamTaskTool({ agentId: "at--dev--worker", sessionKey: "agent:at--dev--worker:run:run-1" });
    await tool.execute("test", {
      action: "update",
      task_id: "task-1",
      status: "WORKING",
    });

    const task = stores.runs.getTask("dev", "task-1") as any;
    expect(task.status).toBe("WORKING");

    // Worker completes again
    await tool.execute("test", {
      action: "update",
      task_id: "task-1",
      status: "COMPLETED",
      result: "Done with tests",
    });

    const updatedTask = stores.runs.getTask("dev", "task-1") as any;
    expect(updatedTask.status).toBe("COMPLETED");
    expect(updatedTask.result).toBe("Done with tests");
  });

  it("revision_count increments each cycle", async () => {
    const stores = makeStores();
    stores.runs.addTask("dev", {
      id: "task-1",
      team: "dev",
      run_id: "run-1",
      description: "Build feature",
      assigned_to: "worker",
      status: "COMPLETED",
      result: "v1",
      revision_count: 2,
    } as never);
    setTestRegistry(orchestratorTeamConfig, stores);

    const tool = teamTaskTool({ agentId: "at--dev--lead", sessionKey: "agent:at--dev--lead:run:run-1" });
    const result = await tool.execute("test", {
      action: "update",
      task_id: "task-1",
      status: "REVISION_REQUESTED",
      message: "Third revision needed",
    });

    const details = result.details as Record<string, unknown>;
    expect(details.revision_count).toBe(3);
  });

  it("auto-complete blocked during revision (REVISION_REQUESTED is active)", async () => {
    const stores = makeStores();
    // One task completed, one in revision
    stores.runs.addTask("dev", {
      id: "task-1",
      team: "dev",
      run_id: "run-1",
      description: "Task A",
      assigned_to: "worker",
      status: "COMPLETED",
      result: "Done",
    } as never);
    stores.runs.addTask("dev", {
      id: "task-2",
      team: "dev",
      run_id: "run-1",
      description: "Task B (in revision)",
      assigned_to: "worker2",
      status: "REVISION_REQUESTED",
      revision_count: 1,
    } as never);

    const peerConfig: TeamConfig = {
      description: "Peer team",
      coordination: "peer",
      members: {
        worker: { role: "Worker" },
        worker2: { role: "Worker 2" },
      },
    };
    setTestRegistry(peerConfig, stores);

    // task-1 already COMPLETED, task-2 in REVISION_REQUESTED
    // Auto-complete should NOT trigger because REVISION_REQUESTED is active
    const tool = teamTaskTool({ agentId: "at--dev--worker" });
    // Query to verify both tasks are present
    const queryResult = await tool.execute("test", {
      action: "query",
    });

    const queryDetails = queryResult.details as Record<string, unknown>;
    const tasks = queryDetails.tasks as any[];
    expect(tasks).toHaveLength(2);

    // The run should NOT be completed since task-2 is active
    expect(stores.runs.completeRun).not.toHaveBeenCalled();
  });

  it("leaf-task constraint enforced (non-leaf rejected)", async () => {
    const stores = makeStores();
    stores.runs.addTask("dev", {
      id: "task-parent",
      team: "dev",
      run_id: "run-1",
      description: "Parent task",
      assigned_to: "worker",
      status: "COMPLETED",
      result: "Done",
    } as never);
    stores.runs.addTask("dev", {
      id: "task-child",
      team: "dev",
      run_id: "run-1",
      description: "Child task",
      assigned_to: "worker2",
      status: "WORKING",
      depends_on: ["task-parent"],
    } as never);
    setTestRegistry(orchestratorTeamConfig, stores);

    const tool = teamTaskTool({ agentId: "at--dev--lead", sessionKey: "agent:at--dev--lead:run:run-1" });
    const result = await tool.execute("test", {
      action: "update",
      task_id: "task-parent",
      status: "REVISION_REQUESTED",
      message: "Needs rework",
    });

    const details = result.details as Record<string, unknown>;
    expect(details.error).toContain("active dependents");
    expect(details.error).toContain("leaf tasks");
  });

  it("leaf-task allowed when dependents are all terminal", async () => {
    const stores = makeStores();
    stores.runs.addTask("dev", {
      id: "task-parent",
      team: "dev",
      run_id: "run-1",
      description: "Parent task",
      assigned_to: "worker",
      status: "COMPLETED",
      result: "Done",
    } as never);
    stores.runs.addTask("dev", {
      id: "task-child",
      team: "dev",
      run_id: "run-1",
      description: "Child task",
      assigned_to: "worker2",
      status: "COMPLETED",
      result: "Also done",
      depends_on: ["task-parent"],
    } as never);
    setTestRegistry(orchestratorTeamConfig, stores);

    const tool = teamTaskTool({ agentId: "at--dev--lead", sessionKey: "agent:at--dev--lead:run:run-1" });
    const result = await tool.execute("test", {
      action: "update",
      task_id: "task-parent",
      status: "REVISION_REQUESTED",
      message: "Even though child completed, parent needs rework",
    });

    // Should succeed because child task is COMPLETED (terminal)
    const details = result.details as Record<string, unknown>;
    expect(details.status).toBe("REVISION_REQUESTED");
  });

  it("CLI agent respawn on revision request", async () => {
    const cliTeamConfig: TeamConfig = {
      description: "CLI orchestrator team",
      coordination: "orchestrator",
      orchestrator: "lead",
      members: {
        lead: { role: "Lead" },
        cli_worker: { role: "Worker", cli: "claude" },
      },
    };
    const stores = makeStores();
    stores.runs.addTask("dev", {
      id: "task-1",
      team: "dev",
      run_id: "run-1",
      description: "Build API endpoint",
      assigned_to: "cli_worker",
      status: "COMPLETED",
      result: "Endpoint created",
    } as never);
    setTestRegistry(cliTeamConfig, stores);

    const tool = teamTaskTool({ agentId: "at--dev--lead", sessionKey: "agent:at--dev--lead:run:run-1" });
    await tool.execute("test", {
      action: "update",
      task_id: "task-1",
      status: "REVISION_REQUESTED",
      message: "Missing authentication middleware",
    });

    expect(spawnCliIfNeeded).toHaveBeenCalledWith(
      expect.anything(),
      "dev",
      "cli_worker",
      cliTeamConfig,
      stores,
      expect.stringContaining("REVISION REQUESTED"),
      "run-1",
    );
  });

  it("multiple revision cycles work correctly", async () => {
    const stores = makeStores();
    stores.runs.addTask("dev", {
      id: "task-1",
      team: "dev",
      run_id: "run-1",
      description: "Build feature",
      assigned_to: "worker",
      status: "COMPLETED",
      result: "v1",
    } as never);
    setTestRegistry(orchestratorTeamConfig, stores);

    const leadTool = teamTaskTool({ agentId: "at--dev--lead", sessionKey: "agent:at--dev--lead:run:run-1" });
    const workerTool = teamTaskTool({ agentId: "at--dev--worker", sessionKey: "agent:at--dev--worker:run:run-1" });

    // Cycle 1: lead rejects
    let result = await leadTool.execute("test", {
      action: "update",
      task_id: "task-1",
      status: "REVISION_REQUESTED",
      message: "Fix styling",
    });
    expect((result.details as any).revision_count).toBe(1);

    // Worker picks up and completes
    await workerTool.execute("test", {
      action: "update",
      task_id: "task-1",
      status: "WORKING",
    });
    await workerTool.execute("test", {
      action: "update",
      task_id: "task-1",
      status: "COMPLETED",
      result: "v2",
    });

    // Cycle 2: lead rejects again
    result = await leadTool.execute("test", {
      action: "update",
      task_id: "task-1",
      status: "REVISION_REQUESTED",
      message: "Still needs tests",
    });
    expect((result.details as any).revision_count).toBe(2);

    // Worker completes final version
    await workerTool.execute("test", {
      action: "update",
      task_id: "task-1",
      status: "WORKING",
    });
    await workerTool.execute("test", {
      action: "update",
      task_id: "task-1",
      status: "COMPLETED",
      result: "v3 with tests",
    });

    const task = stores.runs.getTask("dev", "task-1") as any;
    expect(task.status).toBe("COMPLETED");
    expect(task.result).toBe("v3 with tests");
    expect(task.revision_count).toBe(2);
  });

  it("REVISION_REQUESTED is canceled on run cancel", async () => {
    const stores = makeStores();
    stores.runs.addTask("dev", {
      id: "task-1",
      team: "dev",
      run_id: "run-1",
      description: "Task in revision",
      assigned_to: "worker",
      status: "REVISION_REQUESTED",
      revision_count: 1,
    } as never);

    // The run manager's cancelRun checks REVISION_REQUESTED status
    // Verify it's included in the active states that get canceled
    const { RunManager } = await import("../src/state/run-manager.js");
    const rm = new RunManager("/tmp/test-rm-" + Date.now());
    rm.startRun("dev", "test goal");
    const runs = rm.listRuns();
    const runId = runs[0].id;
    rm.addTask("dev", {
      id: "task-rev",
      team: "dev",
      run_id: runId,
      description: "Rev task",
      assigned_to: "worker",
      status: "REVISION_REQUESTED",
    } as any);

    const cancelResult = rm.cancelRun("dev", "test", runId);
    expect(cancelResult.tasks_canceled).toBe(1);

    const task = rm.getTask("dev", "task-rev");
    expect(task?.status).toBe("CANCELED");
  });

  it("cascade cancel does NOT trigger on REVISION_REQUESTED", async () => {
    const stores = makeStores();
    stores.runs.addTask("dev", {
      id: "task-1",
      team: "dev",
      run_id: "run-1",
      description: "Parent",
      assigned_to: "worker",
      status: "COMPLETED",
      result: "Done",
    } as never);
    stores.runs.addTask("dev", {
      id: "task-2",
      team: "dev",
      run_id: "run-1",
      description: "Child",
      assigned_to: "worker2",
      status: "BLOCKED",
      depends_on: ["task-1"],
    } as never);
    setTestRegistry(orchestratorTeamConfig, stores);

    // First complete parent so child unblocks, then request revision on a leaf
    // The point is that REVISION_REQUESTED itself doesn't cascade-cancel
    const leadTool = teamTaskTool({ agentId: "at--dev--lead", sessionKey: "agent:at--dev--lead:run:run-1" });

    // task-2 has no active dependents, so requesting revision should work
    // But first we need task-2 to be COMPLETED
    stores.runs.updateTask("dev", "task-2", { status: "COMPLETED", result: "Done" });

    const result = await leadTool.execute("test", {
      action: "update",
      task_id: "task-2",
      status: "REVISION_REQUESTED",
      message: "Fix it",
    });

    // Revision should succeed
    expect((result.details as any).status).toBe("REVISION_REQUESTED");

    // Parent task should remain COMPLETED (no cascade)
    const parent = stores.runs.getTask("dev", "task-1") as any;
    expect(parent.status).toBe("COMPLETED");
  });

  it("logs task_revision_requested activity", async () => {
    const stores = makeStores();
    stores.runs.addTask("dev", {
      id: "task-1",
      team: "dev",
      run_id: "run-1",
      description: "Build feature",
      assigned_to: "worker",
      status: "COMPLETED",
      result: "Done",
    } as never);
    setTestRegistry(orchestratorTeamConfig, stores);

    const tool = teamTaskTool({ agentId: "at--dev--lead", sessionKey: "agent:at--dev--lead:run:run-1" });
    await tool.execute("test", {
      action: "update",
      task_id: "task-1",
      status: "REVISION_REQUESTED",
      message: "Needs tests",
    });

    expect(stores.activity.log).toHaveBeenCalledWith(
      "dev", "lead", "task_revision_requested",
      expect.stringContaining("Revision requested"),
      expect.objectContaining({
        target_id: "task-1",
        metadata: expect.objectContaining({
          revision_count: 1,
        }),
      }),
    );
  });

  it("logs task_revision_restarted activity when worker picks up", async () => {
    const stores = makeStores();
    stores.runs.addTask("dev", {
      id: "task-1",
      team: "dev",
      run_id: "run-1",
      description: "Build feature",
      assigned_to: "worker",
      status: "REVISION_REQUESTED",
      revision_count: 1,
      revision_feedback: "Fix it",
    } as never);
    setTestRegistry(orchestratorTeamConfig, stores);

    const tool = teamTaskTool({ agentId: "at--dev--worker", sessionKey: "agent:at--dev--worker:run:run-1" });
    await tool.execute("test", {
      action: "update",
      task_id: "task-1",
      status: "WORKING",
    });

    expect(stores.activity.log).toHaveBeenCalledWith(
      "dev", "worker", "task_revision_restarted",
      expect.stringContaining("Revision restarted"),
      expect.objectContaining({
        target_id: "task-1",
      }),
    );
  });

  it("reviewer gate config respected", async () => {
    const teamConfigWithGates: TeamConfig = {
      ...orchestratorTeamConfig,
      workflow: {
        gates: {
          REVISION_REQUESTED: { reviewer: "worker2" },
        },
      },
    };
    const stores = makeStores();
    stores.runs.addTask("dev", {
      id: "task-1",
      team: "dev",
      run_id: "run-1",
      description: "Build feature",
      assigned_to: "worker",
      status: "COMPLETED",
      result: "Done",
    } as never);
    setTestRegistry(teamConfigWithGates, stores);

    // Lead (orchestrator) tries but reviewer gate says worker2
    const leadTool = teamTaskTool({ agentId: "at--dev--lead", sessionKey: "agent:at--dev--lead:run:run-1" });
    const result = await leadTool.execute("test", {
      action: "update",
      task_id: "task-1",
      status: "REVISION_REQUESTED",
      message: "Feedback",
    });

    // The built-in guard checks orchestrator first, but the gate enforceGates
    // also checks. Since the built-in guard allows orchestrator by default
    // and the gate has a specific reviewer, the gate check in enforceGates applies.
    // Actually, the built-in guard in the REVISION_REQUESTED handler uses
    // the gate's reviewer if configured. Let's check.
    const details = result.details as Record<string, unknown>;
    expect(details.error).toContain("worker2");
  });

  it("notifies worker session on revision request", async () => {
    const stores = makeStores();
    stores.runs.addTask("dev", {
      id: "task-1",
      team: "dev",
      run_id: "run-1",
      description: "Build feature",
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

    const registry = setTestRegistry(orchestratorTeamConfig, stores, { memberSessions });

    const tool = teamTaskTool({ agentId: "at--dev--lead", sessionKey: "agent:at--dev--lead:run:run-1" });
    await tool.execute("test", {
      action: "update",
      task_id: "task-1",
      status: "REVISION_REQUESTED",
      message: "Add error handling",
    });

    expect(registry.enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("Revision Requested"),
      expect.objectContaining({ sessionKey: "agent:at--dev--worker:run:run-1" }),
    );
    expect(registry.requestHeartbeatNow).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "at--dev--worker" }),
    );
  });
});

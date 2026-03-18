import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/tools/cli-spawn-helper.js", () => ({
  spawnCliIfNeeded: vi.fn(async () => {}),
}));

import { setRegistry } from "../src/registry.js";
import { teamRunTool } from "../src/tools/team-run.js";
import type { PluginRegistry, TeamStores } from "../src/registry.js";
import type { TeamConfig } from "../src/types.js";

function makeStores(overrides?: Partial<TeamStores>): TeamStores {
  return {
    kv: {
      save: vi.fn(async () => {}),
      *iterEntries() {},
    } as unknown as TeamStores["kv"],
    events: {
      getTopics: vi.fn(() => []),
      save: vi.fn(async () => {}),
    } as unknown as TeamStores["events"],
    docs: {} as TeamStores["docs"],
    runs: {
      startRun: vi.fn((_team: string, _goal: string, orchestrator?: string) => ({
        run_id: "run-1",
        status: "WORKING",
        orchestrator,
      })),
      getWorkingRuns: vi.fn(() => []),
      listTasks: vi.fn(() => []),
      getRun: vi.fn(() => ({ found: false })),
      completeRun: vi.fn(),
      cancelRun: vi.fn(),
      save: vi.fn(async () => {}),
    } as unknown as TeamStores["runs"],
    messages: {} as TeamStores["messages"],
    activity: {
      log: vi.fn(),
      save: vi.fn(async () => {}),
    } as unknown as TeamStores["activity"],
    ...overrides,
  };
}

function setTestRegistry(teamConfig: TeamConfig, stores: TeamStores) {
  const registry: PluginRegistry = {
    config: { teams: { dev: teamConfig } },
    teams: new Map([["dev", stores]]),
    memberSessions: new Map(),
    sessionIndex: new Map(),
    invalidatedSessions: new Set(),
    getTeamStores: (team: string) => (team === "dev" ? stores : undefined),
    getTeamConfig: (team: string) => (team === "dev" ? teamConfig : undefined),
    enqueueSystemEvent: vi.fn(() => true),
    requestHeartbeatNow: vi.fn(),
  };
  setRegistry(registry);
}

describe("teamRunTool", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns REQUIRED_ACTION for native orchestrator teams", async () => {
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
    setTestRegistry(teamConfig, stores);

    const tool = teamRunTool({ agentId: "main", sessionKey: "session-main" });
    const result = await tool.execute("test", {
      action: "start",
      team: "dev",
      goal: "Build feature X",
    });

    const details = result.details as Record<string, unknown>;
    const action = details.REQUIRED_ACTION as string;
    // Should include structured activation brief
    expect(action).toContain("sessions_send");
    expect(action).toMatch(/sessionKey: "agent:at--dev--lead:run:run-1"/);
    expect(action).toContain("Build feature X");
    expect(action).toContain("DECOMPOSE");
    expect(action).toContain("DO NOT");
    expect(action).toContain("worker: Worker");
    // Should NOT pre-activate workers
    expect(action).not.toContain("agent:at--dev--worker:run:run-1");
    // Should instruct about system notifications for later activations
    expect(action).toContain("activation notifications");
    expect(details.WARNING).toMatch(/sessions_send/);
    expect(details.team_agents).toEqual({
      lead: "at--dev--lead",
      worker: "at--dev--worker",
    });
  });

  it("includes task parameter in peer next_steps", async () => {
    const teamConfig: TeamConfig = {
      description: "Peer team",
      coordination: "peer",
      members: {
        alice: { role: "Alice" },
        bob: { role: "Bob", cli: "claude" },
        carol: { role: "Carol" },
      },
    };
    const stores = makeStores();
    setTestRegistry(teamConfig, stores);

    const tool = teamRunTool({ agentId: "main", sessionKey: "session-main" });
    const result = await tool.execute("test", {
      action: "start",
      team: "dev",
      goal: "Build feature Y",
    });

    const details = result.details as Record<string, unknown>;
    expect(details.REQUIRED_ACTION).toBe(
      "Call each sessions_send in next_steps above to activate the peer agents. Do not create tasks — peers handle that themselves.",
    );
    expect(details.WARNING).toBe(
      "Peer-mode task creation must come from peer members, not the main session.",
    );
    const steps = details.next_steps as string[];
    expect(steps).toHaveLength(2);
    expect(steps[0]).toContain("sessions_send");
    expect(steps[0]).toContain("agent:at--dev--alice:run:run-1");
    expect(steps[0]).toContain("MUST create tasks");
    expect(steps[1]).toContain("agent:at--dev--carol:run:run-1");
  });

  it("rejects start when active run exists (active run guard)", async () => {
    const teamConfig: TeamConfig = {
      description: "Orchestrator team",
      coordination: "orchestrator",
      orchestrator: "lead",
      members: { lead: { role: "Lead" } },
    };
    const stores = makeStores({
      runs: {
        getWorkingRuns: vi.fn(() => [{
          id: "existing-run",
          team: "dev",
          goal: "Already running",
          status: "WORKING",
          tasks: [],
          started_at: Date.now(),
          updated_at: Date.now(),
        }]),
      } as unknown as TeamStores["runs"],
    });
    setTestRegistry(teamConfig, stores);

    const tool = teamRunTool({ agentId: "main", sessionKey: "session-main" });
    const result = await tool.execute("test", {
      action: "start",
      team: "dev",
      goal: "New goal",
    });

    const details = result.details as Record<string, unknown>;
    expect(details.error).toContain("already has an active run");
    expect(details.error).toContain("existing-run");
  });

  it("status includes pending_completion when all tasks terminal", async () => {
    const teamConfig: TeamConfig = {
      description: "Orchestrator team",
      coordination: "orchestrator",
      orchestrator: "lead",
      members: { lead: { role: "Lead" }, worker: { role: "Worker" } },
    };
    const stores = makeStores({
      runs: {
        getRun: vi.fn(() => ({
          found: true,
          run: {
            id: "run-1",
            status: "WORKING",
            goal: "Test",
            orchestrator: "lead",
            started_at: Date.now(),
            tasks: [
              { id: "t1", status: "COMPLETED", assigned_to: "worker", description: "Task 1" },
              { id: "t2", status: "FAILED", assigned_to: "worker", description: "Task 2" },
            ],
          },
        })),
        getWorkingRuns: vi.fn(() => []),
        listRuns: vi.fn(() => []),
        save: vi.fn(async () => {}),
      } as unknown as TeamStores["runs"],
    });
    setTestRegistry(teamConfig, stores);

    const tool = teamRunTool({ agentId: "at--dev--lead", sessionKey: "agent:at--dev--lead:run:run-1" });
    const result = await tool.execute("test", { action: "status", team: "dev", run_id: "run-1" });

    const details = result.details as Record<string, unknown>;
    expect(details.pending_completion).toBeDefined();
    const pc = details.pending_completion as Record<string, string>;
    expect(pc.summary).toContain("All 2 tasks terminal");
    expect(pc.action).toContain('team_run(action: "complete"');
    expect(details.REQUIRED_ACTION).toContain("Complete the run");
  });

  it("status does NOT include pending_completion when non-terminal tasks exist", async () => {
    const teamConfig: TeamConfig = {
      description: "Orchestrator team",
      coordination: "orchestrator",
      orchestrator: "lead",
      members: { lead: { role: "Lead" }, worker: { role: "Worker" } },
    };
    const stores = makeStores({
      runs: {
        getRun: vi.fn(() => ({
          found: true,
          run: {
            id: "run-1",
            status: "WORKING",
            goal: "Test",
            orchestrator: "lead",
            started_at: Date.now(),
            tasks: [
              { id: "t1", status: "COMPLETED", assigned_to: "worker", description: "Task 1" },
              { id: "t2", status: "WORKING", assigned_to: "worker", description: "Task 2" },
            ],
          },
        })),
        getWorkingRuns: vi.fn(() => []),
        listRuns: vi.fn(() => []),
        save: vi.fn(async () => {}),
      } as unknown as TeamStores["runs"],
    });
    setTestRegistry(teamConfig, stores);

    const tool = teamRunTool({ agentId: "at--dev--lead", sessionKey: "agent:at--dev--lead:run:run-1" });
    const result = await tool.execute("test", { action: "status", team: "dev", run_id: "run-1" });

    const details = result.details as Record<string, unknown>;
    expect(details.pending_completion).toBeUndefined();
  });

  it("status includes reactivation_needed for PENDING tasks with active sessions", async () => {
    const teamConfig: TeamConfig = {
      description: "Orchestrator team",
      coordination: "orchestrator",
      orchestrator: "lead",
      members: { lead: { role: "Lead" }, worker: { role: "Worker" } },
    };
    const stores = makeStores({
      runs: {
        getRun: vi.fn(() => ({
          found: true,
          run: {
            id: "run-1",
            status: "WORKING",
            goal: "Test",
            orchestrator: "lead",
            started_at: Date.now(),
            tasks: [
              { id: "t1", status: "PENDING", assigned_to: "worker", description: "Build the thing" },
            ],
          },
        })),
        getWorkingRuns: vi.fn(() => []),
        listRuns: vi.fn(() => []),
        save: vi.fn(async () => {}),
      } as unknown as TeamStores["runs"],
    });
    const registry: PluginRegistry = {
      config: { teams: { dev: teamConfig } },
      teams: new Map([["dev", stores]]),
      memberSessions: new Map([
        ["at--dev--worker", new Map([
          ["run-1", { sessionKey: "agent:at--dev--worker:run:run-1", runId: "run-1", createdAt: Date.now() }],
        ])],
      ]),
      sessionIndex: new Map(),
      invalidatedSessions: new Set(),
      getTeamStores: (team: string) => (team === "dev" ? stores : undefined),
      getTeamConfig: (team: string) => (team === "dev" ? teamConfig : undefined),
      enqueueSystemEvent: vi.fn(() => true),
      requestHeartbeatNow: vi.fn(),
    };
    setRegistry(registry);

    const tool = teamRunTool({ agentId: "at--dev--lead", sessionKey: "agent:at--dev--lead:run:run-1" });
    const result = await tool.execute("test", { action: "status", team: "dev", run_id: "run-1" });

    const details = result.details as Record<string, unknown>;
    expect(details.agents_starting).toBeDefined();
    expect(details.reactivation_needed).toBeDefined();
    const reactivation = details.reactivation_needed as string[];
    expect(reactivation.length).toBe(1);
    expect(reactivation[0]).toContain("worker");
    expect(reactivation[0]).toContain("sessions_send");
  });

  it("complete response includes REQUIRED_ACTION for orchestrator to relay to main agent", async () => {
    const teamConfig: TeamConfig = {
      description: "Orchestrator team",
      coordination: "orchestrator",
      orchestrator: "lead",
      members: { lead: { role: "Lead" } },
    };
    const stores = makeStores({
      runs: {
        completeRun: vi.fn(() => ({ ok: true, status: "COMPLETED" })),
        getRun: vi.fn(() => ({
          found: true,
          run: {
            id: "run-1",
            status: "COMPLETED",
            requester_session: "session-main",
            tasks: [],
          },
        })),
        archiveRun: vi.fn(async () => {}),
        save: vi.fn(async () => {}),
      } as unknown as TeamStores["runs"],
    });
    setTestRegistry(teamConfig, stores);

    const tool = teamRunTool({ agentId: "at--dev--lead", sessionKey: "agent:at--dev--lead:run:run-1" });
    const result = await tool.execute("test", {
      action: "complete",
      result: "All work done",
    });

    const details = result.details as Record<string, unknown>;
    expect(details.REQUIRED_ACTION).toBeDefined();
    expect(details.REQUIRED_ACTION).toContain("sessions_send");
    expect(details.REQUIRED_ACTION).toContain("session-main");
    expect(details.REQUIRED_ACTION).toContain("Run completed");
  });

  it("returns a tool error instead of throwing when completion is blocked", async () => {
    const teamConfig: TeamConfig = {
      description: "Orchestrator team",
      coordination: "orchestrator",
      orchestrator: "lead",
      members: {
        lead: { role: "Lead" },
      },
    };
    const stores = makeStores({
      runs: {
        completeRun: vi.fn(() => {
          throw new Error("Cannot complete run with non-terminal tasks.");
        }),
      } as unknown as TeamStores["runs"],
    });
    setTestRegistry(teamConfig, stores);

    const tool = teamRunTool({ agentId: "at--dev--lead" });
    const result = await tool.execute("test", {
      action: "complete",
    });

    expect((result.details as Record<string, unknown>).error).toContain(
      "Cannot complete run with non-terminal tasks.",
    );
  });

  it("status includes idle orchestrator warning when zero tasks past grace period", async () => {
    const teamConfig: TeamConfig = {
      description: "Orchestrator team",
      coordination: "orchestrator",
      orchestrator: "lead",
      members: {
        lead: { role: "Lead" },
        worker: { role: "Worker", skills: ["coding"] },
      },
    };
    const stores = makeStores({
      runs: {
        getRun: vi.fn(() => ({
          found: true,
          run: {
            id: "run-1",
            team: "dev",
            goal: "Build it",
            status: "WORKING",
            orchestrator: "lead",
            started_at: Date.now() - 60_000, // 60s ago — past 45s grace
            updated_at: Date.now(),
            tasks: [],
          },
        })),
        getWorkingRuns: vi.fn(() => []),
        listRuns: vi.fn(() => []),
        save: vi.fn(async () => {}),
      } as unknown as TeamStores["runs"],
    });
    setTestRegistry(teamConfig, stores);

    const tool = teamRunTool({ agentId: "at--dev--lead", sessionKey: "agent:at--dev--lead:run:run-1" });
    const result = await tool.execute("test", { action: "status", team: "dev", run_id: "run-1" });

    const details = result.details as Record<string, unknown>;
    expect(details.WARNING).toContain("ZERO tasks");
    expect(details.REQUIRED_ACTION).toContain("sessions_send");
    expect(details.REQUIRED_ACTION).toContain("NOT created any tasks");
  });

  it("status does NOT warn for orchestrator within grace period", async () => {
    const teamConfig: TeamConfig = {
      description: "Orchestrator team",
      coordination: "orchestrator",
      orchestrator: "lead",
      members: {
        lead: { role: "Lead" },
        worker: { role: "Worker" },
      },
    };
    const stores = makeStores({
      runs: {
        getRun: vi.fn(() => ({
          found: true,
          run: {
            id: "run-1",
            team: "dev",
            goal: "Build it",
            status: "WORKING",
            orchestrator: "lead",
            started_at: Date.now() - 10_000, // 10s — within 45s grace
            updated_at: Date.now(),
            tasks: [],
          },
        })),
        getWorkingRuns: vi.fn(() => []),
        listRuns: vi.fn(() => []),
        save: vi.fn(async () => {}),
      } as unknown as TeamStores["runs"],
    });
    setTestRegistry(teamConfig, stores);

    const tool = teamRunTool({ agentId: "at--dev--lead", sessionKey: "agent:at--dev--lead:run:run-1" });
    const result = await tool.execute("test", { action: "status", team: "dev", run_id: "run-1" });

    const details = result.details as Record<string, unknown>;
    expect(details.WARNING).toBeUndefined();
  });

  it("status does NOT warn for orchestrator that has tasks", async () => {
    const teamConfig: TeamConfig = {
      description: "Orchestrator team",
      coordination: "orchestrator",
      orchestrator: "lead",
      members: {
        lead: { role: "Lead" },
        worker: { role: "Worker" },
      },
    };
    const stores = makeStores({
      runs: {
        getRun: vi.fn(() => ({
          found: true,
          run: {
            id: "run-1",
            team: "dev",
            goal: "Build it",
            status: "WORKING",
            orchestrator: "lead",
            started_at: Date.now() - 60_000,
            updated_at: Date.now(),
            tasks: [{ id: "t1", team: "dev", run_id: "run-1", description: "Do stuff", status: "WORKING", assigned_to: "worker", created_at: Date.now(), updated_at: Date.now() }],
          },
        })),
        getWorkingRuns: vi.fn(() => []),
        listRuns: vi.fn(() => []),
        save: vi.fn(async () => {}),
      } as unknown as TeamStores["runs"],
    });
    setTestRegistry(teamConfig, stores);

    const tool = teamRunTool({ agentId: "at--dev--lead", sessionKey: "agent:at--dev--lead:run:run-1" });
    const result = await tool.execute("test", { action: "status", team: "dev", run_id: "run-1" });

    const details = result.details as Record<string, unknown>;
    // Should not have the idle orchestrator warning (has tasks)
    expect(details.WARNING).toBeUndefined();
  });
});

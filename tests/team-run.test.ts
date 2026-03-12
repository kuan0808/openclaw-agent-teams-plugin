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
    sessions: new Map(),
    sessionToAgent: new Map(),
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
    expect(details.REQUIRED_ACTION).toMatch(/sessions_send\(\{ message: "Coordinate the team by decomposing the goal into small, finishable tasks:/);
    expect(details.REQUIRED_ACTION).toMatch(/sessionKey: "agent:at--dev--lead:run:run-1"/);
    expect(details.WARNING).toMatch(/DO NOT call team_task yourself/);
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
      "You MUST send messages to the peer agents now and let them coordinate the work. DO NOT create tasks directly as __leader__.",
    );
    expect(details.WARNING).toBe(
      "Peer-mode task creation must come from peer members, not the main session.",
    );
    expect(details.next_steps).toEqual([
      `Send to peer agent: sessions_send({ message: "Collaborate on the team goal: Build feature Y. First inspect existing tasks and inbox. If you already have active tasks, continue them before creating more work for yourself.", sessionKey: "agent:at--dev--alice:run:run-1" })`,
      `Send to peer agent: sessions_send({ message: "Collaborate on the team goal: Build feature Y. First inspect existing tasks and inbox. If you already have active tasks, continue them before creating more work for yourself.", sessionKey: "agent:at--dev--carol:run:run-1" })`,
    ]);
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
});

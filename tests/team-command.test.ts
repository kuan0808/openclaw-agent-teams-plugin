import { beforeEach, describe, expect, it, vi } from "vitest";

import { setRegistry } from "../src/registry.js";
import { createTeamCommands } from "../src/commands/team-command.js";
import type { PluginRegistry, TeamStores } from "../src/registry.js";
import type { TeamConfig } from "../src/types.js";

function makeStores(): TeamStores {
  return {
    kv: {} as TeamStores["kv"],
    events: {} as TeamStores["events"],
    docs: {} as TeamStores["docs"],
    runs: {
      getRun: vi.fn(() => ({ found: false })),
      save: vi.fn(async () => {}),
      cancelRun: vi.fn(() => ({ ok: true, status: "CANCELED", tasks_canceled: 0 })),
    } as unknown as TeamStores["runs"],
    messages: {} as TeamStores["messages"],
    activity: {
      log: vi.fn(),
      save: vi.fn(async () => {}),
    } as unknown as TeamStores["activity"],
  };
}

function setTestRegistry(teamConfig: TeamConfig, stores: TeamStores) {
  const registry: PluginRegistry = {
    config: { teams: { dev: teamConfig } },
    teams: new Map([["dev", stores]]),
    sessions: new Map(),
    sessionToAgent: new Map(),
    getTeamStores: (team: string) => (team === "dev" ? stores : undefined),
    getTeamConfig: (team: string) => (team === "dev" ? teamConfig : undefined),
    enqueueSystemEvent: vi.fn(() => true),
    requestHeartbeatNow: vi.fn(),
  };
  setRegistry(registry);
}

describe("team command dispatcher", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("registers a single valid team command", () => {
    const commands = createTeamCommands();

    expect(commands).toHaveLength(1);
    expect(commands[0]!.name).toBe("team");
    expect(commands[0]!.acceptsArgs).toBe(true);
  });

  it("dispatches '/team status <team>' through the single command handler", async () => {
    const teamConfig: TeamConfig = {
      description: "Peer team",
      coordination: "peer",
      members: {
        alice: { role: "Alice" },
      },
    };
    const stores = makeStores();
    stores.runs.getRun = vi.fn(() => ({
      found: true,
      run: {
        id: "run-1",
        status: "WORKING",
        goal: "Build it",
        started_at: Date.now(),
        tasks: [],
      },
    })) as unknown as TeamStores["runs"]["getRun"];
    setTestRegistry(teamConfig, stores);

    const commands = createTeamCommands();
    const teamCmd = commands[0]!;
    const result = await teamCmd.handler({
      args: "status dev",
      config: {},
      isAuthorizedSender: false,
      senderId: "user",
    });

    expect(result.text).toContain("Team: dev");
    expect(result.text).toContain("Run: run-1 (WORKING)");
  });
});

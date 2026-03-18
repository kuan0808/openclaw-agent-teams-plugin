import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildMainAgentContext } from "../src/cli/prompt-builder.js";
import { setRegistry } from "../src/registry.js";
import { createAgentStartHook } from "../src/hooks/agent-start.js";
import { createCompactionHook } from "../src/hooks/compaction.js";
import type { PluginRegistry, TeamStores } from "../src/registry.js";
import type { AgentTeamsConfig, TeamConfig } from "../src/types.js";

// ── Shared test helpers ──────────────────────────────────────────────────

function makeMinimalStores(): TeamStores {
  return {
    kv: {
      save: vi.fn(async () => {}),
      list: vi.fn(() => []),
      get: vi.fn(() => ({ found: false })),
      *iterEntries() {},
    } as unknown as TeamStores["kv"],
    events: { getTopics: vi.fn(() => []), save: vi.fn(async () => {}) } as unknown as TeamStores["events"],
    docs: {} as TeamStores["docs"],
    runs: {
      getRun: vi.fn(() => ({ found: false })),
      getWorkingRuns: vi.fn(() => []),
      listTasks: vi.fn(() => []),
      save: vi.fn(async () => {}),
    } as unknown as TeamStores["runs"],
    messages: {} as TeamStores["messages"],
    activity: { log: vi.fn(), save: vi.fn(async () => {}) } as unknown as TeamStores["activity"],
  };
}

function setTestRegistry(teamConfig: TeamConfig, stores?: TeamStores) {
  const s = stores ?? makeMinimalStores();
  const enqueueSystemEvent = vi.fn(() => true);

  const registry: PluginRegistry = {
    config: { teams: { dev: teamConfig } },
    teams: new Map([["dev", s]]),
    memberSessions: new Map(),
    sessionIndex: new Map(),
    invalidatedSessions: new Set(),
    getTeamStores: (team: string) => (team === "dev" ? s : undefined),
    getTeamConfig: (team: string) => (team === "dev" ? teamConfig : undefined),
    enqueueSystemEvent,
    requestHeartbeatNow: vi.fn(),
  };
  setRegistry(registry);
  return { registry, enqueueSystemEvent, stores: s };
}

function setEmptyRegistry() {
  const registry: PluginRegistry = {
    config: { teams: {} },
    teams: new Map(),
    memberSessions: new Map(),
    sessionIndex: new Map(),
    invalidatedSessions: new Set(),
    getTeamStores: () => undefined,
    getTeamConfig: () => undefined,
    enqueueSystemEvent: vi.fn(() => true),
    requestHeartbeatNow: vi.fn(),
  };
  setRegistry(registry);
}

// ── buildMainAgentContext ─────────────────────────────────────────────────

describe("buildMainAgentContext", () => {
  it("generates team directory with all configured teams", () => {
    const config: AgentTeamsConfig = {
      teams: {
        dev: {
          description: "Development team",
          coordination: "orchestrator",
          orchestrator: "lead",
          members: { lead: { role: "Lead" }, coder: { role: "Coder" } },
        },
        qa: {
          description: "QA team",
          coordination: "peer",
          members: { tester1: { role: "Tester" }, tester2: { role: "Tester" } },
        },
      },
    };

    const result = buildMainAgentContext(config);
    expect(result).toContain("| dev |");
    expect(result).toContain("| qa |");
  });

  it("includes coordination mode for each team", () => {
    const config: AgentTeamsConfig = {
      teams: {
        dev: {
          description: "Dev",
          coordination: "orchestrator",
          orchestrator: "lead",
          members: { lead: { role: "Lead" } },
        },
        qa: {
          description: "QA",
          coordination: "peer",
          members: { t1: { role: "T" } },
        },
      },
    };

    const result = buildMainAgentContext(config);
    expect(result).toContain("orchestrator (lead)");
    expect(result).toContain("peer");
  });

  it("includes member names for each team", () => {
    const config: AgentTeamsConfig = {
      teams: {
        dev: {
          description: "Dev",
          coordination: "peer",
          members: { alice: { role: "Dev" }, bob: { role: "Dev" } },
        },
      },
    };

    const result = buildMainAgentContext(config);
    expect(result).toContain("alice, bob");
  });

  it("contains How to Use section with team_run example", () => {
    const config: AgentTeamsConfig = {
      teams: {
        dev: {
          description: "Dev",
          coordination: "peer",
          members: { a: { role: "A" } },
        },
      },
    };

    const result = buildMainAgentContext(config);
    expect(result).toContain("### How to Use");
    expect(result).toContain('team_run(action: "start"');
  });

  it("contains REQUIRED_ACTION instruction", () => {
    const config: AgentTeamsConfig = {
      teams: {
        dev: {
          description: "Dev",
          coordination: "peer",
          members: { a: { role: "A" } },
        },
      },
    };

    const result = buildMainAgentContext(config);
    expect(result).toContain("REQUIRED_ACTION");
  });

  it("says team works autonomously after activation", () => {
    const config: AgentTeamsConfig = {
      teams: {
        dev: {
          description: "Dev",
          coordination: "orchestrator",
          orchestrator: "lead",
          members: { lead: { role: "Lead" }, coder: { role: "Coder" } },
        },
      },
    };

    const result = buildMainAgentContext(config);
    expect(result).toContain("team works autonomously");
    expect(result).toContain("Do NOT call team_task directly");
  });

  it("includes notification relay instruction", () => {
    const config: AgentTeamsConfig = {
      teams: {
        dev: {
          description: "Dev",
          coordination: "orchestrator",
          orchestrator: "lead",
          members: { lead: { role: "Lead" } },
        },
      },
    };

    const result = buildMainAgentContext(config);
    expect(result).toContain("update the user on team progress");
    expect(result).toContain("[<Team> Team]");
  });

  it("handles single-team config correctly", () => {
    const config: AgentTeamsConfig = {
      teams: {
        solo: {
          description: "Solo team",
          coordination: "peer",
          members: { worker: { role: "Worker" } },
        },
      },
    };

    const result = buildMainAgentContext(config);
    expect(result).toContain("| solo |");
    expect(result).toContain("worker");
    expect(result).not.toContain("undefined");
  });

  it("shows orchestrator name for orchestrator teams", () => {
    const config: AgentTeamsConfig = {
      teams: {
        dev: {
          description: "Dev",
          coordination: "orchestrator",
          orchestrator: "manager",
          members: { manager: { role: "Manager" }, dev: { role: "Dev" } },
        },
      },
    };

    const result = buildMainAgentContext(config);
    expect(result).toContain("orchestrator (manager)");
  });
});

// ── agent-start hook: main agent path ────────────────────────────────────

describe("agent-start hook — main agent", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns prependContext for non-team agent (e.g. 'user')", async () => {
    const teamConfig: TeamConfig = {
      description: "Dev team",
      coordination: "orchestrator",
      orchestrator: "lead",
      members: { lead: { role: "Lead" }, worker: { role: "Worker" } },
    };
    setTestRegistry(teamConfig);

    const hook = createAgentStartHook();
    const result = await hook({ prompt: "test" }, { agentId: "user" });

    expect(result).toBeDefined();
    expect(result!.prependContext).toContain("Agent Teams Plugin");
    expect(result!.prependContext).toContain("dev");
  });

  it("returns prependContext for undefined agentId", async () => {
    const teamConfig: TeamConfig = {
      description: "Dev team",
      coordination: "peer",
      members: { a: { role: "A" } },
    };
    setTestRegistry(teamConfig);

    const hook = createAgentStartHook();
    const result = await hook({ prompt: "test" }, {});

    expect(result).toBeDefined();
    expect(result!.prependContext).toContain("Agent Teams Plugin");
  });

  it("returns undefined when no teams configured", async () => {
    setEmptyRegistry();

    const hook = createAgentStartHook();
    const result = await hook({ prompt: "test" }, { agentId: "user" });

    expect(result).toBeUndefined();
  });

  it("regression: still returns full prompt for at--team--member agents", async () => {
    const teamConfig: TeamConfig = {
      description: "Dev team",
      coordination: "orchestrator",
      orchestrator: "lead",
      members: { lead: { role: "Lead" }, worker: { role: "Worker" } },
    };
    setTestRegistry(teamConfig);

    const hook = createAgentStartHook();
    const result = await hook(
      { prompt: "test" },
      { agentId: "at--dev--worker", sessionKey: "agent:at--dev--worker:run:run-1" },
    );

    expect(result).toBeDefined();
    // Team agent context includes "Your Role", not "Agent Teams Plugin"
    expect(result!.prependContext).toContain("Your Role");
    expect(result!.prependContext).toContain("worker");
  });

  it("regression: returns undefined for CLI team agents", async () => {
    const teamConfig: TeamConfig = {
      description: "Dev team",
      coordination: "orchestrator",
      orchestrator: "lead",
      members: {
        lead: { role: "Lead" },
        cli_worker: { role: "CLI Worker", cli: "claude" },
      },
    };
    setTestRegistry(teamConfig);

    const hook = createAgentStartHook();
    const result = await hook(
      { prompt: "test" },
      { agentId: "at--dev--cli_worker" },
    );

    expect(result).toBeUndefined();
  });
});

// ── compaction hook: main agent path ─────────────────────────────────────

describe("compaction hook — main agent", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("enqueues team directory for non-team agents after compaction", async () => {
    const teamConfig: TeamConfig = {
      description: "Dev team",
      coordination: "orchestrator",
      orchestrator: "lead",
      members: { lead: { role: "Lead" } },
    };
    const { enqueueSystemEvent } = setTestRegistry(teamConfig);

    const hook = createCompactionHook();
    await hook(
      { messageCount: 10 },
      { agentId: "user", sessionKey: "session-main" },
    );

    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
    const [text, opts] = enqueueSystemEvent.mock.calls[0]!;
    expect(text).toContain("Agent Teams");
    expect(text).toContain("dev");
    expect(text).toContain("REQUIRED_ACTION");
    expect(opts.sessionKey).toBe("session-main");
  });

  it("no-op for non-team agents without sessionKey", async () => {
    const teamConfig: TeamConfig = {
      description: "Dev team",
      coordination: "peer",
      members: { a: { role: "A" } },
    };
    const { enqueueSystemEvent } = setTestRegistry(teamConfig);

    const hook = createCompactionHook();
    await hook({ messageCount: 10 }, { agentId: "user" });

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("regression: still enqueues full state for team agents", async () => {
    const teamConfig: TeamConfig = {
      description: "Dev team",
      coordination: "orchestrator",
      orchestrator: "lead",
      members: { lead: { role: "Lead" } },
    };
    const { enqueueSystemEvent } = setTestRegistry(teamConfig);

    const hook = createCompactionHook();
    await hook(
      { messageCount: 10 },
      { agentId: "at--dev--lead", sessionKey: "agent:at--dev--lead:run:run-1" },
    );

    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
    const [text] = enqueueSystemEvent.mock.calls[0]!;
    expect(text).toContain("Post-Compaction State Restore");
    expect(text).toContain("lead");
  });
});

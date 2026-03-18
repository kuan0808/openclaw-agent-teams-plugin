import { beforeEach, describe, expect, it, vi } from "vitest";

import { setRegistry } from "../src/registry.js";
import { teamMemoryTool } from "../src/tools/team-memory.js";
import type { PluginRegistry, TeamStores } from "../src/registry.js";
import type { TeamConfig } from "../src/types.js";

function makeStores(): TeamStores {
  return {
    kv: {} as TeamStores["kv"],
    events: {} as TeamStores["events"],
    docs: {
      set: vi.fn(async (key: string) => ({
        ok: true,
        size_bytes: key.length,
        path: `/tmp/${key}`,
      })),
      save: vi.fn(async () => {}),
    } as unknown as TeamStores["docs"],
    runs: {} as TeamStores["runs"],
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
    memberSessions: new Map(),
    sessionIndex: new Map(),
    getTeamStores: (team: string) => (team === "dev" ? stores : undefined),
    getTeamConfig: (team: string) => (team === "dev" ? teamConfig : undefined),
    enqueueSystemEvent: vi.fn(() => true),
    requestHeartbeatNow: vi.fn(),
  };
  setRegistry(registry);
}

describe("teamMemoryTool", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sanitizes docs keys that look like paths instead of failing", async () => {
    const teamConfig: TeamConfig = {
      description: "Peer team",
      coordination: "peer",
      members: {
        alice: { role: "Alice" },
      },
    };
    const stores = makeStores();
    setTestRegistry(teamConfig, stores);

    const tool = teamMemoryTool({ agentId: "at--dev--alice" });
    const result = await tool.execute("test", {
      action: "set",
      store: "docs",
      key: "utility-library/architecture.md",
      value: "# Architecture",
      content_type: "text/markdown",
    });

    const details = result.details as Record<string, unknown>;
    expect(stores.docs.set).toHaveBeenCalledWith(
      "utility-library_architecture.md",
      "# Architecture",
      "text/markdown",
      "alice",
    );
    expect(details.key).toBe("utility-library_architecture.md");
    expect(details.warning).toContain("sanitized");
  });
});

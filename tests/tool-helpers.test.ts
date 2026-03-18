import { describe, it, expect, vi, beforeEach } from "vitest";
import { collectLearnings, resolveToolContext, effectiveAgentId } from "../src/tools/tool-helpers.js";
import { setRegistry } from "../src/registry.js";
import type { PluginRegistry, TeamStores } from "../src/registry.js";
import type { TeamConfig } from "../src/types.js";

describe("collectLearnings (enhanced)", () => {
  function makeKv(entries: Array<{ key: string; value: unknown }>) {
    const map = new Map(entries.map((e) => [e.key, e]));
    return {
      *iterEntries() {
        for (const [key, entry] of map) {
          yield [key, entry] as [string, { key: string; value: unknown }];
        }
      },
    };
  }

  it("should collect legacy flat learnings", () => {
    const kv = makeKv([
      { key: "learnings:api-calls", value: "Always retry on 429" },
      { key: "learnings:testing", value: "Mock external deps" },
      { key: "other:stuff", value: "ignored" },
    ]);

    const result = collectLearnings(kv);
    expect(result).toHaveLength(2);
    expect(result[0]!.key).toBe("api-calls");
    expect(result[0]!.value).toBe("Always retry on 429");
  });

  it("should collect structured learnings with confidence", () => {
    const kv = makeKv([
      {
        key: "learnings:failure:task-1",
        value: { content: "Failed due to timeout", confidence: 0.9, category: "failure", timestamp: 1 },
      },
      {
        key: "learnings:pattern:auth",
        value: { content: "Use JWT for auth", confidence: 0.6, category: "pattern", timestamp: 2 },
      },
    ]);

    const result = collectLearnings(kv);
    expect(result).toHaveLength(2);
    // Sorted by confidence descending
    expect(result[0]!.confidence).toBe(0.9);
    expect(result[0]!.category).toBe("failure");
    expect(result[1]!.confidence).toBe(0.6);
    expect(result[1]!.category).toBe("pattern");
  });

  it("should sort by confidence descending", () => {
    const kv = makeKv([
      { key: "learnings:a", value: { content: "Low", confidence: 0.3, category: "insight", timestamp: 1 } },
      { key: "learnings:b", value: { content: "High", confidence: 0.95, category: "fix", timestamp: 2 } },
      { key: "learnings:c", value: { content: "Med", confidence: 0.7, category: "pattern", timestamp: 3 } },
    ]);

    const result = collectLearnings(kv);
    expect(result[0]!.value).toBe("High");
    expect(result[1]!.value).toBe("Med");
    expect(result[2]!.value).toBe("Low");
  });

  it("should respect limit parameter", () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      key: `learnings:item-${i}`,
      value: `Learning ${i}`,
    }));
    const kv = makeKv(entries);

    const result = collectLearnings(kv, 5);
    expect(result).toHaveLength(5);
  });

  it("should default limit to 10", () => {
    const entries = Array.from({ length: 15 }, (_, i) => ({
      key: `learnings:item-${i}`,
      value: `Learning ${i}`,
    }));
    const kv = makeKv(entries);

    const result = collectLearnings(kv);
    expect(result).toHaveLength(10);
  });

  it("should handle mixed legacy and structured entries", () => {
    const kv = makeKv([
      { key: "learnings:old-style", value: "Use caching" },
      { key: "learnings:failure:new-style", value: { content: "Check disk space", confidence: 0.8, category: "failure", timestamp: 1 } },
    ]);

    const result = collectLearnings(kv);
    expect(result).toHaveLength(2);
    // Structured (0.8) should come before legacy (0.5 default)
    expect(result[0]!.value).toBe("Check disk space");
    expect(result[0]!.confidence).toBe(0.8);
    expect(result[1]!.value).toBe("Use caching");
    expect(result[1]!.confidence).toBe(0.5);
  });
});

// ── resolveToolContext error messages ──────────────────────────────────────

describe("resolveToolContext error messages", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function setTestRegistryWithTeams(teams: Record<string, TeamConfig>) {
    const storesMap = new Map<string, TeamStores>();
    for (const name of Object.keys(teams)) {
      storesMap.set(name, {
        kv: {} as TeamStores["kv"],
        events: {} as TeamStores["events"],
        docs: {} as TeamStores["docs"],
        runs: {} as TeamStores["runs"],
        messages: {} as TeamStores["messages"],
        activity: {} as TeamStores["activity"],
      });
    }

    const registry: PluginRegistry = {
      config: { teams },
      teams: storesMap,
      memberSessions: new Map(),
      sessionIndex: new Map(),
      invalidatedSessions: new Set(),
      getTeamStores: (team: string) => storesMap.get(team),
      getTeamConfig: (team: string) => teams[team],
      enqueueSystemEvent: vi.fn(() => true),
      requestHeartbeatNow: vi.fn(),
    };
    setRegistry(registry);
  }

  it("lists available teams when team param is missing", () => {
    setTestRegistryWithTeams({
      dev: {
        description: "Dev",
        coordination: "peer",
        members: { a: { role: "A" } },
      },
      qa: {
        description: "QA",
        coordination: "peer",
        members: { b: { role: "B" } },
      },
    });

    const result = resolveToolContext(undefined, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const text = JSON.stringify(result.error);
      expect(text).toContain("dev");
      expect(text).toContain("qa");
      expect(text).toContain("Available teams");
    }
  });

  it("resolves agentId from sessionKey when ctx.agentId is missing", () => {
    setTestRegistryWithTeams({
      dev: { description: "Dev", coordination: "peer", members: { a: { role: "A" } } },
    });

    // ctx.agentId undefined, but sessionKey encodes a valid team agent
    const resolved = effectiveAgentId({
      sessionKey: "agent:at--dev--worker:run:run-1",
    });
    expect(resolved).toBe("at--dev--worker");
  });

  it("prefers ctx.agentId when it is a valid team agent", () => {
    setTestRegistryWithTeams({
      dev: { description: "Dev", coordination: "peer", members: { a: { role: "A" } } },
    });

    const resolved = effectiveAgentId({
      agentId: "at--dev--lead",
      sessionKey: "agent:at--dev--worker:run:run-1",
    });
    expect(resolved).toBe("at--dev--lead");
  });

  it("returns ctx.agentId when sessionKey has no team agent", () => {
    setTestRegistryWithTeams({
      dev: { description: "Dev", coordination: "peer", members: { a: { role: "A" } } },
    });

    const resolved = effectiveAgentId({
      agentId: "main",
      sessionKey: "some-session-key",
    });
    expect(resolved).toBe("main");
  });

  it("returns undefined when both agentId and sessionKey are missing", () => {
    setTestRegistryWithTeams({
      dev: { description: "Dev", coordination: "peer", members: { a: { role: "A" } } },
    });

    const resolved = effectiveAgentId({});
    expect(resolved).toBeUndefined();
  });

  it("lists available teams when team name is wrong", () => {
    setTestRegistryWithTeams({
      dev: {
        description: "Dev",
        coordination: "peer",
        members: { a: { role: "A" } },
      },
    });

    // Use a non-team agentId so it falls through to teamParam resolution
    const result = resolveToolContext("user", "nonexistent");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const text = JSON.stringify(result.error);
      expect(text).toContain("nonexistent");
      expect(text).toContain("dev");
      expect(text).toContain("Available teams");
    }
  });
});

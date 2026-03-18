import { describe, expect, it } from "vitest";

import {
  collectAllAgentIds,
  injectAgents,
  provisionAgents,
} from "../src/setup/agent-provisioner.js";
import {
  computeSubagentRequirements,
  reconcileHostRuntimeConfig,
} from "../src/setup/runtime-compat.js";
import type { AgentTeamsConfig } from "../src/types.js";

const config: AgentTeamsConfig = {
  teams: {
    alpha: {
      description: "Native orchestrator team",
      coordination: "orchestrator",
      orchestrator: "lead",
      members: {
        lead: { role: "Lead" },
        frontend: { role: "Frontend" },
        backend: { role: "Backend" },
        reviewer: { role: "Reviewer", cli: "codex" },
      },
    },
    beta: {
      description: "Peer team",
      coordination: "peer",
      members: {
        alice: { role: "Alice" },
        bob: { role: "Bob", cli: "claude" },
        carol: { role: "Carol" },
      },
    },
  },
};

describe("computeSubagentRequirements", () => {
  it("computes nested depth and optimized concurrency from team shape", () => {
    const requirements = computeSubagentRequirements(config);

    expect(requirements.maxSpawnDepth).toBe(2);
    expect(requirements.maxConcurrent).toBe(5);
    expect(requirements.maxChildrenPerAgent).toBe(3);
  });
});

describe("reconcileHostRuntimeConfig", () => {
  it("removes invalid defaults allowAgents and raises required subagent defaults", () => {
    const runtimeConfig: Record<string, any> = {
      agents: {
        defaults: {
          subagents: {
            allowAgents: ["legacy"],
            maxConcurrent: 1,
            maxSpawnDepth: 1,
            maxChildrenPerAgent: 1,
          },
        },
      },
      tools: {
        profile: "coding",
      },
    };

    const result = reconcileHostRuntimeConfig(runtimeConfig, config);

    expect(runtimeConfig.agents.defaults.subagents.allowAgents).toBeUndefined();
    expect(runtimeConfig.agents.defaults.subagents.maxSpawnDepth).toBe(2);
    expect(runtimeConfig.agents.defaults.subagents.maxConcurrent).toBe(5);
    expect(runtimeConfig.agents.defaults.subagents.maxChildrenPerAgent).toBe(3);
    expect(result.changes.some((msg) => msg.includes("Removed invalid"))).toBe(true);
  });

  it("preserves stricter existing values", () => {
    const runtimeConfig: Record<string, any> = {
      agents: {
        defaults: {
          subagents: {
            maxConcurrent: 9,
            maxSpawnDepth: 3,
            maxChildrenPerAgent: 4,
          },
        },
      },
    };

    reconcileHostRuntimeConfig(runtimeConfig, config);

    expect(runtimeConfig.agents.defaults.subagents.maxSpawnDepth).toBe(3);
    expect(runtimeConfig.agents.defaults.subagents.maxConcurrent).toBe(9);
    expect(runtimeConfig.agents.defaults.subagents.maxChildrenPerAgent).toBe(4);
  });
});

describe("injectAgents", () => {
  it("injects agents, enables agent-to-agent messaging, and cleans invalid defaults key", () => {
    const provisioned = provisionAgents(config, "/tmp/agent-teams");
    const runtimeConfig: Record<string, any> = {
      agents: {
        list: [],
        defaults: {
          subagents: {
            allowAgents: ["stale"],
          },
        },
      },
      tools: {
        agentToAgent: {
          enabled: false,
          allow: ["existing-agent"],
        },
      },
    };

    const injected = injectAgents(
      runtimeConfig,
      provisioned,
      collectAllAgentIds(config),
    );

    expect(injected).toHaveLength(5);
    expect(runtimeConfig.tools.agentToAgent.enabled).toBe(true);
    expect(runtimeConfig.tools.agentToAgent.allow).toEqual(
      expect.arrayContaining([
        "existing-agent",
        "at--alpha--lead",
        "at--alpha--frontend",
        "at--alpha--backend",
        "at--alpha--reviewer",
        "at--beta--alice",
        "at--beta--bob",
        "at--beta--carol",
      ]),
    );
    expect(runtimeConfig.agents.defaults.subagents).toBeUndefined();
  });
});

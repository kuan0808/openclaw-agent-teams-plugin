/**
 * Agent Provisioner — auto-generate AgentConfig entries for team members.
 *
 * Reads team config and injects agents into the runtime config's agents.list
 * (in-memory only, no disk writes).
 */

import * as path from "node:path";
import type { AgentTeamsConfig, MemberConfig } from "../types.js";
import { makeAgentId, isCliMember } from "../types.js";
import { ensureDir } from "../state/persistence.js";

/**
 * Minimal agent config shape matching OpenClaw's AgentConfig.
 * Only the fields we actually need to set.
 */
export interface ProvisionedAgent {
  id: string;
  model?: { primary?: string };
  workspace?: string;
  subagents?: {
    allowAgents?: string[];
  };
  tools?: {
    deny?: string[];
    allow?: string[];
  };
}

/**
 * Generate agent configs for all team members across all teams.
 */
export function provisionAgents(
  config: AgentTeamsConfig,
  stateDir: string,
): ProvisionedAgent[] {
  const agents: ProvisionedAgent[] = [];

  for (const [teamName, teamConfig] of Object.entries(config.teams)) {
    const allMemberIds = Object.keys(teamConfig.members).map((m) =>
      makeAgentId(teamName, m),
    );

    for (const [memberKey, memberConfig] of Object.entries(teamConfig.members)) {
      // CLI agents are not OpenClaw subagents — skip provisioning
      if (isCliMember(memberConfig)) continue;

      const agentId = makeAgentId(teamName, memberKey);
      const workspaceDir = path.join(stateDir, "workspaces", teamName, memberKey);

      const agent: ProvisionedAgent = {
        id: agentId,
        workspace: workspaceDir,
      };

      // Model override
      if (memberConfig.model?.primary) {
        agent.model = { primary: memberConfig.model.primary };
      }

      // Subagent delegation
      if (memberConfig.can_delegate) {
        agent.subagents = { allowAgents: allMemberIds };
      } else {
        agent.subagents = { allowAgents: [] };
      }

      // Tool restrictions
      if (memberConfig.tools) {
        agent.tools = {};
        if (memberConfig.tools.deny) {
          agent.tools.deny = memberConfig.tools.deny;
        }
        if (memberConfig.tools.allow) {
          agent.tools.allow = memberConfig.tools.allow;
        }
      }

      agents.push(agent);
    }
  }

  return agents;
}

/**
 * Inject provisioned agents into the runtime config's agents.list.
 * Modifies the config object in-place (in-memory only).
 *
 * Returns the list of agent IDs that were injected.
 */
/**
 * Collect ALL member agent IDs (including CLI agents) for a2a allow list.
 */
export function collectAllAgentIds(config: AgentTeamsConfig): string[] {
  const ids: string[] = [];
  for (const [teamName, teamConfig] of Object.entries(config.teams)) {
    for (const memberKey of Object.keys(teamConfig.members)) {
      ids.push(makeAgentId(teamName, memberKey));
    }
  }
  return ids;
}

export function injectAgents(
  runtimeConfig: Record<string, any>,
  agents: ProvisionedAgent[],
  allAgentIds?: string[],
): string[] {
  if (!runtimeConfig.agents) {
    runtimeConfig.agents = {};
  }
  if (!Array.isArray(runtimeConfig.agents.list)) {
    runtimeConfig.agents.list = [];
  }

  const existingIds = new Set(
    runtimeConfig.agents.list
      .filter((a: any) => a && typeof a.id === "string")
      .map((a: any) => a.id),
  );

  const injected: string[] = [];

  for (const agent of agents) {
    if (existingIds.has(agent.id)) {
      continue; // Don't duplicate
    }
    runtimeConfig.agents.list.push(agent);
    injected.push(agent.id);
  }

  // Ensure agentToAgent allow includes all team agent IDs (including CLI agents)
  if (!runtimeConfig.tools) {
    runtimeConfig.tools = {};
  }
  if (!runtimeConfig.tools.agentToAgent) {
    runtimeConfig.tools.agentToAgent = {};
  }
  const a2a = runtimeConfig.tools.agentToAgent;
  if (!Array.isArray(a2a.allow)) {
    a2a.allow = [];
  }
  const existingAllowed = new Set(a2a.allow);
  const idsToAllow = allAgentIds ?? agents.map((a) => a.id);
  for (const id of idsToAllow) {
    if (!existingAllowed.has(id)) {
      a2a.allow.push(id);
    }
  }

  return injected;
}

/**
 * Create workspace directories for all provisioned agents.
 */
export async function createWorkspaces(agents: ProvisionedAgent[]): Promise<void> {
  await Promise.all(
    agents
      .filter((a) => a.workspace)
      .map((a) => ensureDir(a.workspace!)),
  );
}

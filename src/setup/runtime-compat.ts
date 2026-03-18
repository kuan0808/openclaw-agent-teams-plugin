import type { AgentTeamsConfig, TeamConfig } from "../types.js";
import { isCliMember } from "../types.js";

export interface SubagentRequirements {
  maxConcurrent: number;
  maxSpawnDepth: number;
  maxChildrenPerAgent: number;
}

export interface RuntimeCompatResult {
  changes: string[];
  warnings: string[];
  requirements: SubagentRequirements;
}

function countNativeMembers(teamConfig: TeamConfig): number {
  return Object.values(teamConfig.members).filter((member) => !isCliMember(member)).length;
}

function computeTeamChildrenLimit(teamConfig: TeamConfig): number {
  const nativeMembers = countNativeMembers(teamConfig);

  if (nativeMembers === 0) {
    return 0;
  }

  if (teamConfig.coordination === "peer") {
    return nativeMembers;
  }

  const orchestratorKey = teamConfig.orchestrator;
  if (!orchestratorKey) {
    return nativeMembers;
  }

  const orchestrator = teamConfig.members[orchestratorKey];
  if (!orchestrator || isCliMember(orchestrator)) {
    return 0;
  }

  // Include ALL native members (orchestrator + workers) since the main
  // agent spawns sessions for all of them.
  return nativeMembers;
}

export function computeSubagentRequirements(
  config: AgentTeamsConfig,
): SubagentRequirements {
  let maxConcurrent = 0;
  let maxSpawnDepth = 1;
  let maxChildrenPerAgent = 0;

  for (const teamConfig of Object.values(config.teams)) {
    const nativeMembers = countNativeMembers(teamConfig);
    maxConcurrent += nativeMembers;
    maxChildrenPerAgent = Math.max(
      maxChildrenPerAgent,
      computeTeamChildrenLimit(teamConfig),
    );

    if (teamConfig.coordination !== "orchestrator" || !teamConfig.orchestrator) {
      continue;
    }

    const orchestrator = teamConfig.members[teamConfig.orchestrator];
    if (!orchestrator || isCliMember(orchestrator)) {
      continue;
    }

    const nativeWorkers = Object.entries(teamConfig.members).some(([memberKey, memberConfig]) => {
      return memberKey !== teamConfig.orchestrator && !isCliMember(memberConfig);
    });
    if (nativeWorkers) {
      maxSpawnDepth = 2;
    }
  }

  return {
    maxConcurrent: Math.max(maxConcurrent, 1),
    maxSpawnDepth: Math.max(maxSpawnDepth, 1),
    maxChildrenPerAgent: Math.max(maxChildrenPerAgent, 1),
  };
}

export function ensureObject(parent: Record<string, any>, key: string): Record<string, any> {
  if (!parent[key] || typeof parent[key] !== "object" || Array.isArray(parent[key])) {
    parent[key] = {};
  }
  return parent[key] as Record<string, any>;
}

function raiseMinimum(
  target: Record<string, any>,
  key: keyof SubagentRequirements,
  minValue: number,
  changes: string[],
): void {
  const current = typeof target[key] === "number" ? target[key] : undefined;
  if (current === undefined || current < minValue) {
    target[key] = minValue;
    changes.push(
      `Raised agents.defaults.subagents.${key} to ${minValue}${current === undefined ? "" : ` (was ${current})`}.`,
    );
  }
}

export function reconcileHostRuntimeConfig(
  runtimeConfig: Record<string, any>,
  config: AgentTeamsConfig,
): RuntimeCompatResult {
  const changes: string[] = [];
  const warnings: string[] = [];
  const requirements = computeSubagentRequirements(config);

  const agents = ensureObject(runtimeConfig, "agents");
  const defaults = ensureObject(agents, "defaults");
  const subagents = ensureObject(defaults, "subagents");

  if (subagents.allowAgents !== undefined) {
    delete subagents.allowAgents;
    changes.push(
      "Removed invalid agents.defaults.subagents.allowAgents from the host runtime config.",
    );
  }

  raiseMinimum(subagents, "maxConcurrent", requirements.maxConcurrent, changes);
  raiseMinimum(subagents, "maxSpawnDepth", requirements.maxSpawnDepth, changes);
  raiseMinimum(
    subagents,
    "maxChildrenPerAgent",
    requirements.maxChildrenPerAgent,
    changes,
  );

  const tools = ensureObject(runtimeConfig, "tools");
  const agentToAgent = ensureObject(tools, "agentToAgent");
  if (!agentToAgent.enabled) {
    agentToAgent.enabled = true;
    changes.push("Enabled tools.agentToAgent for team agent messaging.");
  }

  // Ensure sessions_send visibility for team agent activation.
  // Without visibility = "all", the main agent cannot call sessions_send
  // to activate team agents (whose sessions it didn't create).
  const sessions = ensureObject(tools, "sessions");
  if (sessions.visibility !== "all") {
    const oldVal = sessions.visibility;
    sessions.visibility = "all";
    changes.push(
      `Set tools.sessions.visibility to "all" for team agent messaging${oldVal ? ` (was "${oldVal}")` : ""}.`,
    );
  }

  // Ensure heartbeat delivers to the user's active channel.
  // Without target, system event notifications (task progress, run completion)
  // are processed but never delivered to Telegram/Discord/etc.
  const heartbeat = ensureObject(defaults, "heartbeat");
  if (!heartbeat.target) {
    heartbeat.target = "last";
    changes.push('Set agents.defaults.heartbeat.target to "last" for team notification delivery.');
  }

  return { changes, warnings, requirements };
}

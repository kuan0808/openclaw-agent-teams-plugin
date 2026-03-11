/**
 * Context utilities — resolve team/member from agentId or explicit params.
 */

import { parseAgentId, isTeamAgent } from "./types.js";

export interface ResolvedTeamContext {
  team: string;
  member: string;
}

/**
 * Resolve team and member from:
 * 1. agentId (for at-- agents, auto-parsed)
 * 2. Explicit `team` param (for non-team agents like Leader)
 *
 * Returns null if context cannot be resolved.
 */
export function resolveTeamContext(
  agentId: string | undefined,
  explicitTeam?: string,
): ResolvedTeamContext | null {
  // For at-- agents, parse from agentId
  if (agentId && isTeamAgent(agentId)) {
    return parseAgentId(agentId);
  }

  // For non-team agents (e.g. Leader), require explicit team param
  if (explicitTeam) {
    return { team: explicitTeam, member: "__leader__" };
  }

  return null;
}

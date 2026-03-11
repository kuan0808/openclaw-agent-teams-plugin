/**
 * Subagent lifecycle hooks — track session mappings and handle delivery routing.
 *
 * - subagent_spawned: register the child session in the registry
 * - subagent_ended: clean up the session mapping
 * - subagent_delivery_target: redirect delivery to orchestrator in orchestrator mode
 */

import { isTeamAgent, parseAgentId, makeAgentId } from "../types.js";
import { getRegistry } from "../registry.js";

/**
 * Track newly spawned subagent sessions in the registry.
 */
export function createSubagentSpawnedHook(): (
  event: { childSessionKey: string; agentId: string; runId: string; mode: string },
  ctx: { runId?: string; childSessionKey?: string; requesterSessionKey?: string },
) => Promise<void> {
  return async (event, _ctx) => {
    if (!isTeamAgent(event.agentId)) return;

    const registry = getRegistry();
    registry.sessions.set(event.agentId, event.childSessionKey);
  };
}

/**
 * Clean up session mapping when a subagent ends.
 */
export function createSubagentEndedHook(): (
  event: { targetSessionKey: string; outcome?: string; error?: string },
  ctx: { runId?: string },
) => Promise<void> {
  return async (event, _ctx) => {
    const registry = getRegistry();

    // Find and remove the session entry matching this sessionKey
    for (const [agentId, sessionKey] of registry.sessions) {
      if (sessionKey === event.targetSessionKey) {
        registry.sessions.delete(agentId);
        break;
      }
    }
  };
}

/**
 * In orchestrator mode, redirect message delivery back to the orchestrator
 * instead of the original external requester.
 *
 * This ensures team member results flow through the orchestrator for
 * consolidation rather than leaking directly to the user.
 */
export function createDeliveryTargetHook(): (
  event: { childSessionKey: string; requesterSessionKey: string; requesterOrigin?: any; spawnMode?: string },
  ctx: any,
) => Promise<{ origin?: any } | void> {
  return async (event, _ctx) => {
    const registry = getRegistry();

    // Find which agent owns this child session
    let childAgentId: string | undefined;
    for (const [agentId, sessionKey] of registry.sessions) {
      if (sessionKey === event.childSessionKey) {
        childAgentId = agentId;
        break;
      }
    }

    if (!childAgentId || !isTeamAgent(childAgentId)) return;

    const parsed = parseAgentId(childAgentId);
    if (!parsed) return;

    const teamConfig = registry.getTeamConfig(parsed.team);
    if (!teamConfig || teamConfig.coordination !== "orchestrator") return;
    if (!teamConfig.orchestrator) return;

    // Don't redirect if the child IS the orchestrator
    if (parsed.member === teamConfig.orchestrator) return;

    // Find the orchestrator's session key
    const orchestratorAgentId = makeAgentId(parsed.team, teamConfig.orchestrator);
    const orchestratorSession = registry.sessions.get(orchestratorAgentId);

    if (!orchestratorSession) return;

    // Redirect delivery to the orchestrator
    return {
      origin: {
        sessionKey: orchestratorSession,
        type: "agent",
      },
    };
  };
}

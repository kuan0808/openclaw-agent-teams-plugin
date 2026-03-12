/**
 * Subagent lifecycle hooks — track session mappings and handle delivery routing.
 *
 * [FALLBACK-ONLY] These hooks operate on the legacy spawn path (sessions_spawn).
 * In the per-run session model, session lifecycle is managed by the plugin
 * via agent-start hook and run completion cleanup.
 *
 * - subagent_spawned: register the child session in the legacy registry
 * - subagent_ended: clean up the legacy session mapping
 * - subagent_delivery_target: redirect delivery to orchestrator in orchestrator mode
 */

import { isTeamAgent, parseAgentId, makeAgentId, parseRunSessionKey } from "../types.js";
import { getRegistry, resolveAgentSession } from "../registry.js";

/**
 * [FALLBACK-ONLY] Track newly spawned subagent sessions in the legacy registry.
 * Per-run sessions are registered in the agent-start hook instead.
 */
export function createSubagentSpawnedHook(): (
  event: { childSessionKey: string; agentId: string; runId: string; mode: string },
  ctx: { runId?: string; childSessionKey?: string; requesterSessionKey?: string },
) => Promise<void> {
  return async (event, _ctx) => {
    if (!isTeamAgent(event.agentId)) return;

    // Skip if this is a per-run session (managed by agent-start hook)
    if (parseRunSessionKey(event.childSessionKey)) return;

    const registry = getRegistry();
    registry.sessions.set(event.agentId, event.childSessionKey);
    registry.sessionToAgent.set(event.childSessionKey, event.agentId);
  };
}

/**
 * [FALLBACK-ONLY] Clean up session mapping when a subagent ends.
 * Per-run sessions are cleaned up on run completion instead.
 */
export function createSubagentEndedHook(): (
  event: { targetSessionKey: string; outcome?: string; error?: string },
  ctx: { runId?: string },
) => Promise<void> {
  return async (event, _ctx) => {
    const registry = getRegistry();

    // Check if it's a per-run session
    const parsedRun = parseRunSessionKey(event.targetSessionKey);
    if (parsedRun) {
      // Clean up per-run session
      const agentSessions = registry.memberSessions.get(parsedRun.agentId);
      if (agentSessions) {
        agentSessions.delete(parsedRun.runId);
        if (agentSessions.size === 0) {
          registry.memberSessions.delete(parsedRun.agentId);
        }
      }
      registry.sessionIndex.delete(event.targetSessionKey);
      return;
    }

    // Legacy spawn path: use reverse index for O(1) lookup
    const agentId = registry.sessionToAgent.get(event.targetSessionKey);
    if (agentId) {
      registry.sessions.delete(agentId);
      registry.sessionToAgent.delete(event.targetSessionKey);
    }
  };
}

/**
 * In orchestrator mode, redirect message delivery back to the orchestrator
 * instead of the original external requester.
 *
 * This ensures team member results flow through the orchestrator for
 * consolidation rather than leaking directly to the user.
 *
 * Works for both per-run sessions and legacy spawn path.
 */
export function createDeliveryTargetHook(): (
  event: { childSessionKey: string; requesterSessionKey: string; requesterOrigin?: any; spawnMode?: string },
  ctx: any,
) => Promise<{ origin?: any } | void> {
  return async (event, _ctx) => {
    const registry = getRegistry();

    // Try per-run session index first, then legacy reverse index
    let childAgentId: string | undefined;
    const parsedRun = parseRunSessionKey(event.childSessionKey);
    if (parsedRun) {
      childAgentId = parsedRun.agentId;
    } else {
      const indexed = registry.sessionIndex.get(event.childSessionKey);
      childAgentId = indexed?.agentId ?? registry.sessionToAgent.get(event.childSessionKey);
    }

    if (!childAgentId || !isTeamAgent(childAgentId)) return;

    const parsed = parseAgentId(childAgentId);
    if (!parsed) return;

    const teamConfig = registry.getTeamConfig(parsed.team);
    if (!teamConfig || teamConfig.coordination !== "orchestrator") return;
    if (!teamConfig.orchestrator) return;

    // Don't redirect if the child IS the orchestrator
    if (parsed.member === teamConfig.orchestrator) return;

    // Find the orchestrator's session key — prefer per-run session for same run
    const orchestratorAgentId = makeAgentId(parsed.team, teamConfig.orchestrator);
    const orchestratorSession = resolveAgentSession(registry, orchestratorAgentId, parsedRun?.runId);
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

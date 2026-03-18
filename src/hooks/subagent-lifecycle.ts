/**
 * Subagent lifecycle hooks — session cleanup and delivery routing.
 *
 * - subagent_ended: clean up per-run session, fail orphaned WORKING tasks
 * - subagent_delivery_target: redirect delivery to orchestrator in orchestrator mode
 */

import { isTeamAgent, parseAgentId, makeAgentId, parseRunSessionKey } from "../types.js";
import { getRegistry, resolveAgentSession } from "../registry.js";
import { TERMINAL_TASK_STATES } from "../state/run-manager.js";

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
      // Fail orphaned WORKING tasks for this agent's run session (1D)
      const parsed = parseAgentId(parsedRun.agentId);
      if (parsed) {
        const stores = registry.getTeamStores(parsed.team);
        if (stores) {
          const runResult = stores.runs.getRun(parsed.team, parsedRun.runId);
          if (runResult.found) {
            const orphaned = runResult.run.tasks.filter(
              t => t.assigned_to === parsed.member && t.status === "WORKING",
            );
            for (const task of orphaned) {
              stores.runs.updateTask(parsed.team, task.id, {
                status: "FAILED",
                message: "Agent session ended while task was in progress",
              });
              stores.activity.log(parsed.team, parsed.member, "task_failed",
                `Task failed: agent session ended unexpectedly`, {
                  target_id: task.id,
                  metadata: { reason: "session_ended" },
                });
            }
            if (orphaned.length > 0) {
              try {
                await Promise.all([stores.runs.save(), stores.activity.save()]);
              } catch { /* best-effort save */ }
            }
          }
        }
      }

      // Clean up per-run session
      const agentSessions = registry.memberSessions.get(parsedRun.agentId);
      if (agentSessions) {
        agentSessions.delete(parsedRun.runId);
        if (agentSessions.size === 0) {
          registry.memberSessions.delete(parsedRun.agentId);
        }
      }
      registry.sessionIndex.delete(event.targetSessionKey);
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

    // Resolve agent ID from session key
    let childAgentId: string | undefined;
    const parsedRun = parseRunSessionKey(event.childSessionKey);
    if (parsedRun) {
      childAgentId = parsedRun.agentId;
    } else {
      const indexed = registry.sessionIndex.get(event.childSessionKey);
      childAgentId = indexed?.agentId;
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

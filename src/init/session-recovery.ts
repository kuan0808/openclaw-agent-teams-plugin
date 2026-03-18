/**
 * Recover per-run session maps from persisted active runs.
 */

import type { TeamStores, PluginRegistry } from "../registry.js";
import { registerRunSession } from "../registry.js";
import { makeAgentId, makeRunSessionKey } from "../types.js";
import { TERMINAL_TASK_STATES } from "../state/run-manager.js";

/**
 * Walk active WORKING runs and rebuild the session registry
 * for agents that have non-terminal tasks.
 */
export function recoverRunSessions(
  teamsMap: Map<string, TeamStores>,
  registry: PluginRegistry,
): void {
  for (const [teamName, stores] of teamsMap) {
    const workingRuns = stores.runs.getWorkingRuns();
    for (const run of workingRuns) {
      for (const task of run.tasks) {
        if (!task.assigned_to) continue;
        if (TERMINAL_TASK_STATES.has(task.status)) continue;

        const agentId = makeAgentId(teamName, task.assigned_to);
        const sessionKey = makeRunSessionKey(agentId, run.id);
        registerRunSession(registry, agentId, run.id, sessionKey, run.started_at);
      }
    }
  }
}

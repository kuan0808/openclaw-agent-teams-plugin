/**
 * Shared CLI agent spawn helper.
 *
 * Extracted from team-task.ts so both team-run.ts and team-task.ts
 * can trigger CLI agent spawning on task assignment.
 */

import type { TeamConfig } from "../types.js";
import { makeAgentId, makeRunSessionKey, isCliMember, getCliCwd } from "../types.js";
import type { PluginRegistry, TeamStores } from "../registry.js";
import { registerRunSession } from "../registry.js";
import { buildSystemPrompt } from "../cli/prompt-builder.js";
import { autoTransitionPendingToWorking } from "./tool-helpers.js";

export interface SpawnCliParams {
  registry: PluginRegistry;
  team: string;
  assignedTo: string;
  teamConfig: TeamConfig;
  stores: TeamStores;
  taskDescription: string;
}

/**
 * Spawn a CLI agent for a team member if the member is configured as a CLI agent
 * and is not already alive.
 */
export async function spawnCliIfNeeded(
  registry: PluginRegistry,
  team: string,
  assignedTo: string,
  teamConfig: TeamConfig,
  stores: TeamStores,
  taskDescription: string,
  runId?: string,
): Promise<void> {
  const memberConfig = teamConfig.members[assignedTo];
  if (!memberConfig || !isCliMember(memberConfig)) return;

  // Lazy CLI init: gateway doesn't await async activation, so CLI infra
  // may not be ready yet. Ensure it's initialized before first spawn.
  if (registry.ensureCliReady) {
    await registry.ensureCliReady();
  }

  const cliSpawner = registry.cliSpawner;
  if (!cliSpawner) return;

  const assigneeAgentId = makeAgentId(team, assignedTo);
  if (cliSpawner.isAlive(assigneeAgentId)) return;

  try {
    const systemPrompt = await buildSystemPrompt({
      team,
      member: assignedTo,
      teamConfig,
      memberConfig,
      stores,
      initialTask: taskDescription,
      isCli: true,
      runId,
    });

    await cliSpawner.spawn({
      agentId: assigneeAgentId,
      team,
      member: assignedTo,
      cli: memberConfig.cli!,
      cwd: getCliCwd(memberConfig),
      systemPrompt,
      initialTask: taskDescription,
      model: memberConfig.model?.primary,
      thinking: memberConfig.cli_options?.thinking,
      verbose: memberConfig.cli_options?.verbose,
      extraArgs: memberConfig.cli_options?.extra_args,
    });

    // Register run session so CLI agent tools can resolve runId
    if (runId) {
      const sessionKey = makeRunSessionKey(assigneeAgentId, runId);
      registerRunSession(registry, assigneeAgentId, runId, sessionKey, Date.now());
    }

    // Auto-transition PENDING tasks to WORKING for this CLI agent
    await autoTransitionPendingToWorking(team, assignedTo, stores);
  } catch (err) {
    // Log with error details for debugging
    const errMsg = err instanceof Error ? err.message : String(err);
    stores.activity.log(team, assignedTo, "task_failed",
      `Failed to spawn CLI agent for ${assignedTo}: ${errMsg}`, {
        metadata: { cli: memberConfig.cli, error: errMsg },
      });
    await stores.activity.save();
  }
}

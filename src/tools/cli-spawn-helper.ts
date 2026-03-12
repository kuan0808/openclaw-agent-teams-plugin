/**
 * Shared CLI agent spawn helper.
 *
 * Extracted from team-task.ts so both team-run.ts and team-task.ts
 * can trigger CLI agent spawning on task assignment.
 */

import type { TeamConfig } from "../types.js";
import { makeAgentId, isCliMember, getCliCwd } from "../types.js";
import type { PluginRegistry, TeamStores } from "../registry.js";
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
): Promise<void> {
  const memberConfig = teamConfig.members[assignedTo];
  if (!memberConfig || !isCliMember(memberConfig)) return;

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

    // Auto-transition PENDING tasks to WORKING for this CLI agent
    await autoTransitionPendingToWorking(team, assignedTo, stores);
  } catch {
    // Log but don't fail the task creation/update
    stores.activity.log(team, assignedTo, "task_failed",
      `Failed to spawn CLI agent for ${assignedTo}`, {
        metadata: { cli: memberConfig.cli },
      });
    await stores.activity.save();
  }
}

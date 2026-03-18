/**
 * Requester notification and native assignee wake-up helpers.
 */

import type { TeamTask, TeamConfig } from "../types.js";
import type { TeamStores } from "../registry.js";
import { getRegistry, resolveAgentSession } from "../registry.js";
import { makeAgentId } from "../types.js";
import { safeSaveAll } from "./result-helpers.js";

/**
 * Push a system event notification to the original requester (Main Agent).
 */
export function notifyRequester(team: string, message: string, runId?: string): void {
  const registry = getRegistry();
  const stores = registry.getTeamStores(team);
  if (!stores) return;
  const run = stores.runs.getRun(team, runId);
  if (!run.found || !run.run.requester_session) return;
  registry.enqueueSystemEvent(
    `[${team} Team] ${message}`,
    { sessionKey: run.run.requester_session },
  );
  registry.requestHeartbeatNow({ sessionKey: run.run.requester_session });
  stores.activity.log(team, "__system__", "requester_notified", message, {
    target_id: runId,
    metadata: { requester_session: run.run.requester_session },
  });
}

/**
 * Wake a native assignee that already has an active session.
 */
export async function wakeActiveNativeAssignee(
  team: string,
  task: Pick<TeamTask, "id" | "description" | "assigned_to" | "status" | "run_id">,
  stores: TeamStores,
): Promise<boolean> {
  if (!task.assigned_to) return false;

  const registry = getRegistry();
  const agentId = makeAgentId(team, task.assigned_to);

  const sessionKey = resolveAgentSession(registry, agentId, task.run_id);
  if (!sessionKey) return false;

  let changed = false;
  if (task.status === "PENDING" || task.status === "REVISION_REQUESTED") {
    const fromStatus = task.status;
    const updateFields: Parameters<typeof stores.runs.updateTask>[2] = {
      status: "WORKING",
      message: fromStatus === "REVISION_REQUESTED"
        ? `Revision picked up by ${task.assigned_to}; session notified.`
        : `Assigned to ${task.assigned_to}; session notified.`,
    };
    if (fromStatus === "REVISION_REQUESTED") {
      updateFields.revision_feedback = "";
    }
    const updated = stores.runs.updateTask(team, task.id, updateFields);
    if (updated) {
      const activityType = fromStatus === "REVISION_REQUESTED" ? "task_revision_restarted" as const : "task_updated" as const;
      stores.activity.log(team, task.assigned_to!, activityType,
        `Task status: ${fromStatus} → WORKING`, {
          target_id: task.id,
          metadata: {
            from_status: fromStatus,
            to_status: "WORKING",
            auto_notified: true,
          },
        });
      changed = true;
    }
  }

  registry.enqueueSystemEvent(
    `[Team Update] New team task assigned to you: ${task.id} — ${task.description.slice(0, 160)}. Check team_task(action: query, filter: "mine") and team_inbox for details.`,
    { sessionKey },
  );
  registry.requestHeartbeatNow({
    agentId,
    reason: "task-assigned",
    sessionKey,
  });

  if (changed) {
    await safeSaveAll([stores.runs.save(), stores.activity.save()]);
  }

  return true;
}

/**
 * Format a member directory listing (excluding one member, typically the orchestrator).
 * Shared by activation briefs and reactivation messages.
 */
export function formatMemberDirectory(teamConfig: TeamConfig, exclude: string): string {
  return Object.entries(teamConfig.members)
    .filter(([k]) => k !== exclude)
    .map(([k, cfg]) => {
      const skills = cfg.skills?.length ? ` [${cfg.skills.join(", ")}]` : "";
      return `- ${k}: ${cfg.role ?? "member"}${skills}`;
    })
    .join("\n");
}

/**
 * Build an activation message for a member being assigned a task.
 * Returns a string with real newlines — use JSON.stringify() when embedding in instructions.
 */
export function buildMemberActivationMessage(task?: { id: string; description: string }): string {
  if (!task) {
    return `You have been assigned tasks. Call team_task(action: "query", filter: "mine") to see your assignments.`;
  }
  return (
    `Your task: ${task.description}\n\n` +
    `Steps:\n` +
    `1. Call team_task(action: "query", filter: "mine") to see full assignment details.\n` +
    `2. Do your work. Share intermediate results via team_memory if useful.\n` +
    `3. When done, you MUST call team_task(action: "update", task_id: "${task.id}", status: "COMPLETED", result: "<summary>").\n\n` +
    `Start working now.`
  );
}

/**
 * Build a forceful re-activation message for an idle orchestrator
 * that has not created any tasks.
 */
export function buildOrchReactivationMessage(teamConfig: TeamConfig, goal?: string): string {
  const memberList = formatMemberDirectory(teamConfig, teamConfig.orchestrator!);

  return (
    `You have NOT created any tasks yet. Create tasks NOW.\n\n` +
    `Call team_task(action: "create", description: "<task>", assign_to: "<member>") for each subtask.\n\n` +
    (goal ? `Goal: ${goal}\n\n` : "") +
    `Team members:\n${memberList}\n\n` +
    `DO NOT respond with text only — call team_task immediately.`
  );
}

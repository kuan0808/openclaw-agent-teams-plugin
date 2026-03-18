/**
 * Task auto-transition and status counting helpers.
 */

import type { TaskState, TeamTask } from "../types.js";
import type { TeamStores } from "../registry.js";
import { safeSaveAll } from "./result-helpers.js";

/**
 * Transition all PENDING tasks assigned to a member to WORKING.
 */
export async function autoTransitionPendingToWorking(
  team: string,
  member: string,
  stores: TeamStores,
  runId?: string,
): Promise<number> {
  const runResult = stores.runs.getRun(team, runId);
  if (!runResult.found) return 0;

  const transitionableTasks = runResult.run.tasks.filter(
    (t) => t.assigned_to === member && (t.status === "PENDING" || t.status === "REVISION_REQUESTED"),
  );
  for (const task of transitionableTasks) {
    const fromStatus = task.status;
    const updateFields: Parameters<typeof stores.runs.updateTask>[2] = { status: "WORKING" };
    if (fromStatus === "REVISION_REQUESTED") {
      updateFields.revision_feedback = "";
    }
    stores.runs.updateTask(team, task.id, updateFields);
    const activityType = fromStatus === "REVISION_REQUESTED" ? "task_revision_restarted" as const : "task_updated" as const;
    stores.activity.log(team, member, activityType,
      `Task status: ${fromStatus} → WORKING`, {
        target_id: task.id,
        metadata: { from_status: fromStatus, to_status: "WORKING" },
      });
  }
  if (transitionableTasks.length > 0) {
    await safeSaveAll([stores.runs.save(), stores.activity.save()]);
  }
  return transitionableTasks.length;
}

/**
 * Single-pass task status counting.
 */
export function countByStatus(tasks: TeamTask[]): Record<TaskState, number> {
  const counts: Record<string, number> = {
    BLOCKED: 0,
    PENDING: 0,
    WORKING: 0,
    INPUT_REQUIRED: 0,
    COMPLETED: 0,
    FAILED: 0,
    CANCELED: 0,
    REVISION_REQUESTED: 0,
  };
  for (const t of tasks) {
    counts[t.status] = (counts[t.status] ?? 0) + 1;
  }
  return counts as Record<TaskState, number>;
}

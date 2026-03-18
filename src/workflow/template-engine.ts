/**
 * Workflow Template Engine.
 *
 * Converts workflow templates into chains of dependent tasks using the
 * existing task system. Handles fail-loopback by creating rework tasks
 * and re-blocking downstream stages.
 */

import type { TeamConfig, TeamTask, WorkflowTemplate, WorkflowStage, TaskState } from "../types.js";
import { routeTask } from "../routing/task-dispatcher.js";

export interface GeneratedTaskDef {
  id: string;
  description: string;
  assigned_to?: string;
  status: TaskState;
  depends_on?: string[];
  routing_reason?: string;
  workflow_stage: string;
}

/**
 * Generate a chain of dependent tasks from a workflow template.
 *
 * Each stage becomes a task. Later stages depend on earlier ones.
 * The first stage starts as PENDING; subsequent stages start BLOCKED.
 */
export function generateTaskChain(
  template: WorkflowTemplate,
  goal: string,
  teamConfig: TeamConfig,
  runId: string,
  existingTasks: TeamTask[],
): GeneratedTaskDef[] {
  const tasks: GeneratedTaskDef[] = [];
  const stageToTaskId = new Map<string, string>();

  for (let i = 0; i < template.stages.length; i++) {
    const stage = template.stages[i]!;
    const taskId = `task-${runId}-stage-${stage.name}`;
    stageToTaskId.set(stage.name, taskId);

    // Determine dependencies: depends on previous stage
    const depends_on: string[] = [];
    if (i > 0) {
      const prevStage = template.stages[i - 1]!;
      const prevTaskId = stageToTaskId.get(prevStage.name);
      if (prevTaskId) depends_on.push(prevTaskId);
    }

    const { assigned_to, routing_reason } = resolveStageAssignment(
      teamConfig, stage, existingTasks, `[${stage.name}] ${goal}`,
    );

    const status: TaskState = i === 0 ? "PENDING" : "BLOCKED";

    tasks.push({
      id: taskId,
      description: `[${stage.name}] ${goal}`,
      assigned_to,
      status,
      depends_on: depends_on.length > 0 ? depends_on : undefined,
      routing_reason,
      workflow_stage: stage.name,
    });
  }

  return tasks;
}

/**
 * Handle a fail-loopback: when a stage fails, create a rework task
 * for the target stage and re-block all downstream stages.
 *
 * Returns the list of new task definitions to create and existing
 * task IDs to re-block.
 */
export function handleFailLoopback(
  template: WorkflowTemplate,
  failedStageName: string,
  failedTask: TeamTask,
  allTasks: TeamTask[],
  teamConfig: TeamConfig,
  runId: string,
): {
  reworkTask: GeneratedTaskDef;
  tasksToReblock: string[];
} | null {
  if (!template.fail_handlers) return null;

  const revertToStage = template.fail_handlers[failedStageName];
  if (!revertToStage) return null;

  // Find the revert-to stage in the template
  const stageIndex = template.stages.findIndex((s) => s.name === revertToStage);
  if (stageIndex === -1) return null;

  const stage = template.stages[stageIndex]!;
  const reworkId = `task-${runId}-rework-${stage.name}-${Date.now()}`;

  // Resolve assignment: role-based, or fall back to original stage assignee
  const { assigned_to: roleAssignee, routing_reason } = resolveStageAssignment(
    teamConfig, stage, allTasks,
    `[${stage.name} - rework] ${failedTask.description}`,
    "workflow_rework",
  );
  let assigned_to = roleAssignee;
  if (!assigned_to || routing_reason.startsWith("fallback")) {
    // Prefer whoever was originally assigned to this stage
    const originalStageTask = allTasks.find((t) => t.workflow_stage === revertToStage);
    if (originalStageTask?.assigned_to) {
      assigned_to = originalStageTask.assigned_to;
    }
  }

  const failContext = failedTask.message
    ? ` (Failure reason: ${failedTask.message})`
    : "";

  const reworkTask: GeneratedTaskDef = {
    id: reworkId,
    description: `[${stage.name} - rework] ${failedTask.description.replace(/^\[.*?\]\s*/, "")}${failContext}`,
    assigned_to,
    status: "PENDING",
    routing_reason,
    workflow_stage: stage.name,
  };

  // Find all downstream stages that need to be re-blocked (Set for O(1) lookups)
  const downstreamStages = new Set(
    template.stages.slice(stageIndex + 1).map((s) => s.name),
  );
  const tasksToReblock: string[] = [];
  for (const task of allTasks) {
    if (
      task.workflow_stage &&
      downstreamStages.has(task.workflow_stage) &&
      (task.status === "COMPLETED" || task.status === "PENDING" || task.status === "WORKING")
    ) {
      tasksToReblock.push(task.id);
    }
  }

  return { reworkTask, tasksToReblock };
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Resolve a task assignment for a workflow stage.
 * Uses role-based lookup first, then falls back to skill-based routing.
 */
function resolveStageAssignment(
  teamConfig: TeamConfig,
  stage: WorkflowStage,
  existingTasks: TeamTask[],
  description: string,
  reasonPrefix = "workflow",
): { assigned_to: string; routing_reason: string } {
  // Try role-based assignment first
  if (stage.role) {
    const member = findMemberByRole(teamConfig, stage.role);
    if (member) {
      return { assigned_to: member, routing_reason: `${reasonPrefix}_role:${stage.role}` };
    }
  }

  // Fall back to skill-based routing
  return routeTask(teamConfig, description, undefined, stage.skills, undefined, existingTasks);
}

/**
 * Find a member by role using priority-based matching (single pass).
 *
 * Priority: exact key match > exact role match > prefix key match > prefix role match
 */
function findMemberByRole(teamConfig: TeamConfig, role: string): string | undefined {
  const lowerRole = role.toLowerCase();
  let prefixKeyMatch: string | undefined;
  let prefixRoleMatch: string | undefined;

  for (const [key, cfg] of Object.entries(teamConfig.members)) {
    const lowerKey = key.toLowerCase();
    const lowerCfgRole = cfg.role?.toLowerCase();

    // Priority 1: exact key match
    if (lowerKey === lowerRole) return key;

    // Priority 2: exact role match
    if (lowerCfgRole === lowerRole) return key;

    // Priority 3 & 4: prefix matches (first found wins)
    if (!prefixKeyMatch && lowerKey.startsWith(lowerRole)) prefixKeyMatch = key;
    if (!prefixRoleMatch && lowerCfgRole?.startsWith(lowerRole)) prefixRoleMatch = key;
  }

  return prefixKeyMatch ?? prefixRoleMatch;
}

/**
 * team_task — Task management for team runs.
 *
 * Actions: create, update, query
 *
 * Enhanced with:
 *  - Deliverables registration
 *  - Approval/verification gates
 *  - Auto-capture structured learnings on COMPLETED/FAILED
 *  - Workflow template fail-loopback handling
 *  - Activity logging on every mutation
 */

import { Type, type Static } from "@sinclair/typebox";
import { getRegistry } from "../registry.js";
import { resolveDependencies, shouldBlock } from "../routing/dependency-resolver.js";
import { routeTask } from "../routing/task-dispatcher.js";
import { handleFailLoopback } from "../workflow/template-engine.js";
import type {
  TaskState,
  TeamConfig,
  TeamTask,
  DeliverableEntry,
  StructuredLearning,
  LearningCategory,
  GateConfig,
} from "../types.js";
import { makeAgentId, isCliMember, getCliCwd } from "../types.js";
import { textResult, errorResult, resolveToolContext, LEARNINGS_KEY_PREFIX, type ToolContext } from "./tool-helpers.js";
import { buildSystemPrompt } from "../cli/prompt-builder.js";

// ── Parameters ──────────────────────────────────────────────────────────

const TASK_STATES: TaskState[] = [
  "BLOCKED",
  "PENDING",
  "WORKING",
  "INPUT_REQUIRED",
  "COMPLETED",
  "FAILED",
  "CANCELED",
];

const Parameters = Type.Object({
  action: Type.Union(
    [
      Type.Literal("create"),
      Type.Literal("update"),
      Type.Literal("query"),
    ],
    { description: "Task action" },
  ),
  team: Type.Optional(
    Type.String({ description: "Team name (auto-resolved for at-- agents)" }),
  ),
  description: Type.Optional(
    Type.String({ description: "Task description (required for create)" }),
  ),
  assign_to: Type.Optional(
    Type.String({ description: "Directly assign to a specific member" }),
  ),
  required_skills: Type.Optional(
    Type.Array(Type.String(), { description: "Skills needed for routing" }),
  ),
  depends_on: Type.Optional(
    Type.Array(Type.String(), { description: "Task IDs this task depends on" }),
  ),
  task_id: Type.Optional(
    Type.String({ description: "Task ID (required for update)" }),
  ),
  status: Type.Optional(
    Type.Union(
      TASK_STATES.map((s) => Type.Literal(s)),
      { description: "New task status" },
    ),
  ),
  result: Type.Optional(
    Type.String({ description: "Task result (for update)" }),
  ),
  message: Type.Optional(
    Type.String({ description: "Status message (for update)" }),
  ),
  filter_status: Type.Optional(
    Type.Array(Type.String(), { description: "Filter tasks by status" }),
  ),
  // ── New: Deliverables ──────────────────────────────────────────────
  deliverables: Type.Optional(
    Type.Array(
      Type.Object({
        type: Type.Union([
          Type.Literal("file"),
          Type.Literal("url"),
          Type.Literal("artifact"),
          Type.Literal("doc"),
        ]),
        path: Type.Optional(Type.String()),
        url: Type.Optional(Type.String()),
        doc_key: Type.Optional(Type.String()),
        description: Type.Optional(Type.String()),
      }),
      { description: "Deliverables to register with the task" },
    ),
  ),
  // ── New: Learning ──────────────────────────────────────────────────
  learning: Type.Optional(
    Type.Object({
      content: Type.String({ description: "What was learned" }),
      confidence: Type.Optional(Type.Number({ description: "Confidence 0.0-1.0" })),
      category: Type.Optional(
        Type.Union([
          Type.Literal("failure"),
          Type.Literal("pattern"),
          Type.Literal("fix"),
          Type.Literal("insight"),
        ]),
      ),
    }, { description: "Structured learning to capture (auto-prompted on COMPLETED/FAILED)" }),
  ),
});

type Params = Static<typeof Parameters>;

// ── Factory ─────────────────────────────────────────────────────────────

export function teamTaskTool(ctx: ToolContext) {
  return {
    name: "team_task",
    label: "Team Task",
    description:
      "Create, update, and query tasks within a team run. Supports skill-based routing, dependency management, deliverables tracking, and approval gates.",
    parameters: Parameters,

    async execute(
      _toolCallId: string,
      params: Params,
      _signal?: AbortSignal,
    ) {
      const resolved = resolveToolContext(ctx.agentId, params.team);
      if (!resolved.ok) return resolved.error;
      const { teamCtx, stores } = resolved;

      const { runs, activity } = stores;
      const registry = getRegistry();
      const teamConfig = registry.getTeamConfig(teamCtx.team);

      switch (params.action) {
        // ── create ────────────────────────────────────────────────────
        case "create": {
          if (!params.description) {
            return errorResult("Parameter 'description' is required for action=create.");
          }

          const currentRun = runs.getRun(teamCtx.team);
          if (!currentRun.found) {
            return errorResult(
              `No active run for team "${teamCtx.team}". Start a run first with team_run action=start.`,
            );
          }

          const existingTasks = runs.listTasks(teamCtx.team);

          // Route the task
          const routing = routeTask(
            teamConfig!,
            params.description,
            params.assign_to,
            params.required_skills,
            teamCtx.member,
            existingTasks,
          );

          // Determine initial status based on dependencies
          const initialStatus: TaskState =
            params.depends_on?.length && shouldBlock(existingTasks, params.depends_on)
              ? "BLOCKED"
              : "PENDING";

          const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

          const task = runs.addTask(teamCtx.team, {
            id: taskId,
            team: teamCtx.team,
            run_id: currentRun.run.id,
            description: params.description,
            assigned_to: routing.assigned_to,
            status: initialStatus,
            depends_on: params.depends_on,
            routing_reason: routing.routing_reason,
          });

          // Log activity
          activity.log(teamCtx.team, teamCtx.member, "task_created", `Task created: ${params.description.slice(0, 80)}`, {
            target_id: taskId,
            metadata: {
              assigned_to: task.assigned_to,
              status: task.status,
              routing_reason: task.routing_reason,
            },
          });
          await Promise.all([runs.save(), activity.save()]);

          // Trigger CLI agent spawn on task assignment
          if (task.assigned_to && teamConfig) {
            await spawnCliIfNeeded(
              registry, teamCtx.team, task.assigned_to, teamConfig,
              stores, params.description,
            );
          }

          return textResult({
            task_id: task.id,
            assigned_to: task.assigned_to ?? null,
            status: task.status,
            routing_reason: task.routing_reason ?? null,
          });
        }

        // ── update ────────────────────────────────────────────────────
        case "update": {
          if (!params.task_id) {
            return errorResult("Parameter 'task_id' is required for action=update.");
          }

          const existing = runs.getTask(teamCtx.team, params.task_id);
          if (!existing) {
            return errorResult(`Task "${params.task_id}" not found in team "${teamCtx.team}".`);
          }

          // ── Gate enforcement ──────────────────────────────────────
          if (params.status) {
            const gateError = enforceGates(
              teamConfig?.workflow?.gates,
              params.status,
              existing,
              params,
              teamCtx.member,
              teamConfig,
            );
            if (gateError) return errorResult(gateError);
          }

          const updates: Partial<Pick<TeamTask, "status" | "result" | "message" | "assigned_to" | "deliverables" | "learning">> = {};

          if (params.status !== undefined) {
            updates.status = params.status as TaskState;
          }
          if (params.result !== undefined) {
            updates.result = params.result;
          }
          if (params.message !== undefined) {
            updates.message = params.message;
          }
          if (params.assign_to !== undefined) {
            updates.assigned_to = params.assign_to;
          }

          // ── Deliverables registration ──────────────────────────────
          if (params.deliverables && params.deliverables.length > 0) {
            const now = Date.now();
            updates.deliverables = params.deliverables.map((d) => ({
              type: d.type,
              path: d.path,
              url: d.url,
              doc_key: d.doc_key,
              description: d.description,
              created_by: teamCtx.member,
              created_at: now,
            } as DeliverableEntry));

            // Log deliverable additions
            activity.log(teamCtx.team, teamCtx.member, "deliverable_added",
              `${params.deliverables.length} deliverable(s) added to task`, {
                target_id: params.task_id,
                metadata: { count: params.deliverables.length },
              });
          }

          // ── Auto-capture learning on COMPLETED/FAILED ──────────────
          if (params.status === "COMPLETED" || params.status === "FAILED") {
            const learning = buildLearning(params, existing);
            if (learning) {
              updates.learning = learning;

              // Also store in KV for cross-run persistence
              const kvKey = `${LEARNINGS_KEY_PREFIX}${learning.category}:${existing.id}`;
              stores.kv.set(kvKey, learning, teamCtx.member);

              activity.log(teamCtx.team, teamCtx.member, "learning_captured",
                `Learning captured: [${learning.category}] ${learning.content.slice(0, 60)}`, {
                  target_id: params.task_id,
                  metadata: { category: learning.category, confidence: learning.confidence },
                });
            }
          }

          const updated = runs.updateTask(teamCtx.team, params.task_id, updates);
          if (!updated) {
            return errorResult(`Failed to update task "${params.task_id}".`);
          }

          // If task was completed, resolve blocked dependencies
          let unblockedTasks: string[] = [];
          if (params.status === "COMPLETED") {
            const allTasks = runs.listTasks(teamCtx.team);
            const unblocked = resolveDependencies(allTasks, params.task_id);
            unblockedTasks = unblocked.map((t) => t.id);

            if (unblockedTasks.length > 0) {
              activity.log(teamCtx.team, teamCtx.member, "dependency_resolved",
                `Unblocked ${unblockedTasks.length} task(s)`, {
                  target_id: params.task_id,
                  metadata: { unblocked: unblockedTasks },
                });
            }

            // Log task completion
            activity.log(teamCtx.team, teamCtx.member, "task_completed",
              `Task completed: ${existing.description.slice(0, 80)}`, {
                target_id: params.task_id,
              });
          }

          // ── Workflow fail-loopback handling ─────────────────────────
          let loopbackResult: Record<string, unknown> | undefined;
          if (params.status === "FAILED" && teamConfig?.workflow?.template && existing.workflow_stage) {
            const allTasks = runs.listTasks(teamCtx.team);
            const currentRun = runs.getRun(teamCtx.team);
            const runId = currentRun.found ? currentRun.run.id : "unknown";

            const loopback = handleFailLoopback(
              teamConfig.workflow.template,
              existing.workflow_stage,
              updated,
              allTasks,
              teamConfig,
              runId,
            );

            if (loopback) {
              // Create the rework task
              const reworkTask = runs.addTask(teamCtx.team, {
                id: loopback.reworkTask.id,
                team: teamCtx.team,
                run_id: runId,
                description: loopback.reworkTask.description,
                assigned_to: loopback.reworkTask.assigned_to,
                status: loopback.reworkTask.status,
                routing_reason: loopback.reworkTask.routing_reason,
                workflow_stage: loopback.reworkTask.workflow_stage,
              });

              // Re-block downstream tasks
              for (const taskIdToReblock of loopback.tasksToReblock) {
                runs.updateTask(teamCtx.team, taskIdToReblock, {
                  status: "BLOCKED",
                  message: `Re-blocked: upstream stage "${existing.workflow_stage}" failed`,
                });
              }

              activity.log(teamCtx.team, teamCtx.member, "workflow_fail_loopback",
                `Fail-loopback: ${existing.workflow_stage} → ${loopback.reworkTask.workflow_stage}`, {
                  target_id: params.task_id,
                  metadata: {
                    rework_task_id: reworkTask.id,
                    reblocked_tasks: loopback.tasksToReblock,
                  },
                });

              loopbackResult = {
                rework_task_id: reworkTask.id,
                rework_stage: loopback.reworkTask.workflow_stage,
                reblocked_tasks: loopback.tasksToReblock,
              };
            }
          }

          // Log status-specific activity (after loopback handling)
          if (params.status === "FAILED") {
            activity.log(teamCtx.team, teamCtx.member, "task_failed",
              `Task failed: ${existing.description.slice(0, 80)}`, {
                target_id: params.task_id,
                metadata: { message: params.message },
              });
          } else if (params.status && params.status !== "COMPLETED") {
            // Log general status update
            activity.log(teamCtx.team, teamCtx.member, "task_updated",
              `Task status: ${existing.status} → ${params.status}`, {
                target_id: params.task_id,
                metadata: { from_status: existing.status, to_status: params.status },
              });
          }

          await Promise.all([runs.save(), stores.kv.save(), activity.save()]);

          // Trigger CLI agent spawn when task is reassigned
          if (params.assign_to && teamConfig) {
            await spawnCliIfNeeded(
              registry, teamCtx.team, params.assign_to, teamConfig,
              stores, existing.description,
            );
          }

          const result: Record<string, unknown> = {
            task_id: updated.id,
            status: updated.status,
            assigned_to: updated.assigned_to ?? null,
            result: updated.result ?? null,
            message: updated.message ?? null,
          };

          if (updated.deliverables && updated.deliverables.length > 0) {
            result.deliverables_count = updated.deliverables.length;
          }

          if (unblockedTasks.length > 0) {
            result.unblocked_tasks = unblockedTasks;
          }

          if (loopbackResult) {
            result.fail_loopback = loopbackResult;
          }

          if (updated.learning) {
            result.learning_captured = true;
          }

          return textResult(result);
        }

        // ── query ─────────────────────────────────────────────────────
        case "query": {
          const tasks = runs.listTasks(teamCtx.team, params.filter_status);

          const taskList = tasks.map((t) => ({
            task_id: t.id,
            description: t.description,
            status: t.status,
            assigned_to: t.assigned_to ?? null,
            depends_on: t.depends_on ?? [],
            result: t.result ?? null,
            message: t.message ?? null,
            deliverables_count: t.deliverables?.length ?? 0,
            workflow_stage: t.workflow_stage ?? null,
            created_at: new Date(t.created_at).toISOString(),
            updated_at: new Date(t.updated_at).toISOString(),
          }));

          return textResult({
            team: teamCtx.team,
            count: taskList.length,
            tasks: taskList,
          });
        }

        default:
          return errorResult(`Unknown action: ${params.action}`);
      }
    },
  };
}

// ── Gate enforcement ────────────────────────────────────────────────────

/** Exported for testing. */
export function enforceGates(
  gates: Record<string, GateConfig> | undefined,
  targetStatus: string,
  task: TeamTask,
  params: Params,
  callerMember: string,
  teamConfig: TeamConfig | undefined,
): string | null {
  if (!gates) return null;

  const gate = gates[targetStatus];
  if (!gate) return null;

  // Check require_deliverables
  if (gate.require_deliverables) {
    const existingDeliverables = task.deliverables?.length ?? 0;
    const newDeliverables = params.deliverables?.length ?? 0;
    if (existingDeliverables + newDeliverables === 0) {
      return `Gate blocked: transitioning to ${targetStatus} requires at least one deliverable. Add deliverables to the task first.`;
    }
  }

  // Check require_result
  if (gate.require_result) {
    if (!params.result && !task.result) {
      return `Gate blocked: transitioning to ${targetStatus} requires a result summary. Provide 'result' parameter.`;
    }
  }

  // Check approver
  if (gate.approver) {
    const requiredApprover = gate.approver === "orchestrator"
      ? teamConfig?.orchestrator
      : gate.approver;
    if (requiredApprover && callerMember !== requiredApprover && callerMember !== "__leader__") {
      return `Gate blocked: only "${requiredApprover}" can transition tasks to ${targetStatus}. Current caller: "${callerMember}".`;
    }
  }

  return null;
}

// ── CLI spawn on task assignment ─────────────────────────────────────────

async function spawnCliIfNeeded(
  registry: import("../registry.js").PluginRegistry,
  team: string,
  assignedTo: string,
  teamConfig: TeamConfig,
  stores: import("../registry.js").TeamStores,
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
  } catch {
    // Log but don't fail the task creation/update
    stores.activity.log(team, assignedTo, "task_failed",
      `Failed to spawn CLI agent for ${assignedTo}`, {
        metadata: { cli: memberConfig.cli },
      });
    await stores.activity.save();
  }
}

// ── Learning auto-capture ───────────────────────────────────────────────

function buildLearning(
  params: Params,
  task: TeamTask,
): StructuredLearning | null {
  // If explicit learning provided, use it
  if (params.learning) {
    const l = params.learning as { content: string; confidence?: number; category?: string };
    return {
      content: l.content,
      confidence: Math.max(0, Math.min(1, l.confidence ?? 0.7)),
      category: (l.category as LearningCategory) ?? (params.status === "FAILED" ? "failure" : "insight"),
      task_id: task.id,
      timestamp: Date.now(),
    };
  }

  // Auto-generate a basic learning from task context
  if (params.status === "FAILED" && params.message) {
    return {
      content: `Task "${task.description.slice(0, 60)}" failed: ${params.message}`,
      confidence: 0.5,
      category: "failure",
      task_id: task.id,
      timestamp: Date.now(),
    };
  }

  if (params.status === "COMPLETED" && params.result) {
    // Only auto-capture if the result seems substantial
    const resultStr = typeof params.result === "string" ? params.result : JSON.stringify(params.result);
    if (resultStr.length > 50) {
      return {
        content: `Completed "${task.description.slice(0, 60)}": ${resultStr.slice(0, 200)}`,
        confidence: 0.5,
        category: "insight",
        task_id: task.id,
        timestamp: Date.now(),
      };
    }
  }

  return null;
}

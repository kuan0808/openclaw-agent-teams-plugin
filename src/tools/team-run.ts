/**
 * team_run — Team execution management.
 *
 * Actions: start, status, complete, cancel
 *
 * Enhanced with:
 *  - Activity logging on every lifecycle event
 *  - Workflow template auto-generation of task chains on start
 */

import { Type, type Static } from "@sinclair/typebox";
import { getRegistry } from "../registry.js";
import { generateTaskChain } from "../workflow/template-engine.js";
import { textResult, errorResult, resolveToolContext, countByStatus, collectLearnings, type ToolContext } from "./tool-helpers.js";

// ── Parameters ──────────────────────────────────────────────────────────

const Parameters = Type.Object({
  action: Type.Union(
    [
      Type.Literal("start"),
      Type.Literal("status"),
      Type.Literal("complete"),
      Type.Literal("cancel"),
    ],
    { description: "Run lifecycle action" },
  ),
  team: Type.Optional(
    Type.String({ description: "Team name (auto-resolved for at-- agents)" }),
  ),
  goal: Type.Optional(
    Type.String({ description: "Goal for the run (required for action=start)" }),
  ),
  result: Type.Optional(
    Type.String({ description: "Result summary (for action=complete)" }),
  ),
  reason: Type.Optional(
    Type.String({ description: "Cancellation reason (for action=cancel)" }),
  ),
});

type Params = Static<typeof Parameters>;

// ── Factory ─────────────────────────────────────────────────────────────

export function teamRunTool(ctx: ToolContext) {
  return {
    name: "team_run",
    label: "Team Run",
    description:
      "Manage team execution runs. Start a new run with a goal, check status, mark complete, or cancel.",
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

      switch (params.action) {
        // ── start ─────────────────────────────────────────────────────
        case "start": {
          if (!params.goal) {
            return errorResult("Parameter 'goal' is required for action=start.");
          }

          const registry = getRegistry();
          const teamConfig = registry.getTeamConfig(teamCtx.team);
          const orchestrator = teamConfig?.orchestrator;

          const result = runs.startRun(teamCtx.team, params.goal, orchestrator);

          // Log run start
          activity.log(teamCtx.team, teamCtx.member, "run_started", `Run started: ${params.goal.slice(0, 80)}`, {
            target_id: result.run_id,
            metadata: { orchestrator: orchestrator ?? null },
          });

          // ── Workflow template: auto-generate task chain ──────────
          let generatedTasks: string[] = [];
          if (teamConfig?.workflow?.template) {
            const existingTasks = runs.listTasks(teamCtx.team);
            const taskDefs = generateTaskChain(
              teamConfig.workflow.template,
              params.goal,
              teamConfig,
              result.run_id,
              existingTasks,
            );

            for (const taskDef of taskDefs) {
              runs.addTask(teamCtx.team, {
                id: taskDef.id,
                team: teamCtx.team,
                run_id: result.run_id,
                description: taskDef.description,
                assigned_to: taskDef.assigned_to,
                status: taskDef.status,
                depends_on: taskDef.depends_on,
                routing_reason: taskDef.routing_reason,
                workflow_stage: taskDef.workflow_stage,
              });
              generatedTasks.push(taskDef.id);
            }

            if (generatedTasks.length > 0) {
              activity.log(teamCtx.team, teamCtx.member, "workflow_stage_advanced",
                `Workflow template generated ${generatedTasks.length} task(s)`, {
                  target_id: result.run_id,
                  metadata: {
                    stages: teamConfig.workflow.template.stages.map((s) => s.name),
                    task_ids: generatedTasks,
                  },
                });
            }
          }

          await Promise.all([runs.save(), activity.save()]);

          const response: Record<string, unknown> = {
            run_id: result.run_id,
            status: result.status,
            orchestrator: result.orchestrator ?? null,
          };

          if (generatedTasks.length > 0) {
            response.workflow_tasks = generatedTasks;
          }

          return textResult(response);
        }

        // ── status ────────────────────────────────────────────────────
        case "status": {
          const result = runs.getRun(teamCtx.team);

          if (!result.found) {
            return textResult({
              status: "no_active_run",
              message: `No active run found for team "${teamCtx.team}".`,
            });
          }

          const run = result.run;
          return textResult({
            run_id: run.id,
            status: run.status,
            goal: run.goal,
            orchestrator: run.orchestrator ?? null,
            started_at: new Date(run.started_at).toISOString(),
            tasks: countByStatus(run.tasks),
          });
        }

        // ── complete ──────────────────────────────────────────────────
        case "complete": {
          const completeResult = runs.completeRun(teamCtx.team, params.result);

          if (!completeResult.ok) {
            return errorResult(`Failed to complete run for team "${teamCtx.team}".`);
          }

          const learnings = collectLearnings(stores.kv);

          // Log run completion
          activity.log(teamCtx.team, teamCtx.member, "run_completed", `Run completed`, {
            metadata: {
              result: params.result?.slice(0, 200),
              learnings_count: learnings.length,
            },
          });

          await Promise.all([runs.save(), stores.kv.save(), activity.save()]);

          return textResult({
            status: completeResult.status,
            learnings,
          });
        }

        // ── cancel ────────────────────────────────────────────────────
        case "cancel": {
          const cancelResult = runs.cancelRun(teamCtx.team, params.reason);

          if (!cancelResult.ok) {
            return errorResult(`Failed to cancel run for team "${teamCtx.team}".`);
          }

          // Log run cancellation
          activity.log(teamCtx.team, teamCtx.member, "run_canceled",
            `Run canceled: ${params.reason?.slice(0, 80) ?? "no reason given"}`, {
              metadata: {
                reason: params.reason,
                tasks_canceled: cancelResult.tasks_canceled,
              },
            });

          await Promise.all([runs.save(), activity.save()]);

          return textResult({
            status: cancelResult.status,
            tasks_canceled: cancelResult.tasks_canceled,
          });
        }

        default:
          return errorResult(`Unknown action: ${params.action}`);
      }
    },
  };
}

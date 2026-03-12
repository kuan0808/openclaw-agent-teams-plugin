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
import { textResult, errorResult, resolveToolContext, resolveRunIdFromSession, safeSaveAll, countByStatus, collectLearnings, clearLearnings, consolidateLearnings, notifyRequester, DESCRIPTION_PREVIEW_LEN, RESULT_PREVIEW_LEN, type ToolContext } from "./tool-helpers.js";
import { spawnCliIfNeeded } from "./cli-spawn-helper.js";
import { makeAgentId, makeRunSessionKey, isCliMember } from "../types.js";

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
  run_id: Type.Optional(
    Type.String({ description: "Run ID (required for complete/cancel with concurrent runs, auto-resolved from session otherwise)" }),
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
      const registry = getRegistry();
      const teamConfig = registry.getTeamConfig(teamCtx.team);

      switch (params.action) {
        // ── start ─────────────────────────────────────────────────────
        case "start": {
          if (!params.goal) {
            return errorResult("Parameter 'goal' is required for action=start.");
          }
          try {
            const orchestrator = teamConfig?.orchestrator;

            const result = runs.startRun(teamCtx.team, params.goal, orchestrator, ctx.sessionKey);

            // Log run start
            activity.log(teamCtx.team, teamCtx.member, "run_started", `Run started: ${params.goal.slice(0, DESCRIPTION_PREVIEW_LEN)}`, {
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

            // ── Knowledge retention: clear learnings if "current-run" ──
            if (teamConfig?.knowledge?.retention === "current-run") {
              clearLearnings(stores.kv);
            }

            // ── Spawn CLI agents for workflow-generated tasks ──────────
            if (generatedTasks.length > 0 && teamConfig) {
              const allTasks = runs.listTasks(teamCtx.team);
              for (const task of allTasks) {
                if (
                  task.assigned_to &&
                  task.status === "PENDING" &&
                  generatedTasks.includes(task.id)
                ) {
                  await spawnCliIfNeeded(
                    registry, teamCtx.team, task.assigned_to, teamConfig,
                    stores, task.description,
                  );
                }
              }
            }

            await safeSaveAll([runs.save(), stores.kv.save(), activity.save()]);

            const response: Record<string, unknown> = {
              run_id: result.run_id,
              status: result.status,
              orchestrator: result.orchestrator ?? null,
            };

            if (generatedTasks.length > 0) {
              response.workflow_tasks = generatedTasks;
            }

            const teamAgents: Record<string, string> = {};
            if (teamConfig) {
              for (const memberKey of Object.keys(teamConfig.members)) {
                teamAgents[memberKey] = makeAgentId(teamCtx.team, memberKey);
              }
            }

            if (teamConfig?.coordination === "orchestrator" && teamConfig.orchestrator) {
              const orchId = makeAgentId(teamCtx.team, teamConfig.orchestrator);
              const orchMember = teamConfig.members[teamConfig.orchestrator];
              if (!orchMember || !isCliMember(orchMember)) {
                const orchRunSessionKey = makeRunSessionKey(orchId, result.run_id);
                response.REQUIRED_ACTION =
                  `You MUST call sessions_send({ message: ${JSON.stringify(`Coordinate the team by decomposing the goal into small, finishable tasks: ${params.goal.slice(0, 100)}`)}, sessionKey: ${JSON.stringify(orchRunSessionKey)} }) NOW. The orchestrator will decompose the goal into tasks and coordinate the team. DO NOT call team_task yourself.`;
                response.WARNING =
                  "DO NOT call team_task yourself. Do not create tasks directly. The orchestrator agent handles all task creation and coordination.";
                response.orchestrator_session = orchRunSessionKey;
              }
            } else if (teamConfig?.coordination === "peer") {
              const peerSteps = Object.entries(teamConfig.members)
                .filter(([, memberCfg]) => !isCliMember(memberCfg))
                .map(([memberKey]) => {
                  const agentId = makeAgentId(teamCtx.team, memberKey);
                  const peerRunSessionKey = makeRunSessionKey(agentId, result.run_id);
                  return `Send to peer agent: sessions_send({ message: ${JSON.stringify(`Collaborate on the team goal: ${params.goal}. First inspect existing tasks and inbox. If you already have active tasks, continue them before creating more work for yourself.`)}, sessionKey: ${JSON.stringify(peerRunSessionKey)} })`;
                });
              response.next_steps = peerSteps;
              if (peerSteps.length > 0) {
                response.REQUIRED_ACTION =
                  "You MUST send messages to the peer agents now and let them coordinate the work. DO NOT create tasks directly as __leader__.";
                response.WARNING =
                  "Peer-mode task creation must come from peer members, not the main session.";
              }
            }

            response.team_agents = teamAgents;

            return textResult(response);
          } catch (err) {
            return errorResult((err as Error).message);
          }
        }

        // ── status ────────────────────────────────────────────────────
        case "status": {
          // Resolve runId: explicit param > session-derived > single active
          const runId = params.run_id ?? resolveRunIdFromSession(ctx.sessionKey);

          if (runId) {
            // Specific run status
            const result = runs.getRun(teamCtx.team, runId);
            if (!result.found) {
              return textResult({
                status: "not_found",
                message: `Run "${runId}" not found for team "${teamCtx.team}".`,
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

          // No specific run: show all active runs summary
          const allRuns = runs.listRuns();
          if (allRuns.length === 0) {
            return textResult({
              status: "no_active_run",
              message: `No active run found for team "${teamCtx.team}".`,
            });
          }

          if (allRuns.length === 1) {
            const run = allRuns[0]!;
            return textResult({
              run_id: run.id,
              status: run.status,
              goal: run.goal,
              orchestrator: run.orchestrator ?? null,
              started_at: new Date(run.started_at).toISOString(),
              tasks: countByStatus(run.tasks),
            });
          }

          // Multiple active runs
          return textResult({
            active_runs: allRuns.map((run) => ({
              run_id: run.id,
              status: run.status,
              goal: run.goal.slice(0, 100),
              orchestrator: run.orchestrator ?? null,
              started_at: new Date(run.started_at).toISOString(),
              tasks: countByStatus(run.tasks),
            })),
          });
        }

        // ── complete ──────────────────────────────────────────────────
        case "complete": {
          try {
            // Resolve runId: explicit param > session-derived > single active
            const targetRunId = params.run_id ?? resolveRunIdFromSession(ctx.sessionKey);
            const completeResult = runs.completeRun(teamCtx.team, params.result, targetRunId);

            if (!completeResult.ok) {
              return errorResult(`Failed to complete run for team "${teamCtx.team}".`);
            }

            const learnings = collectLearnings(stores.kv);

            // Knowledge consolidation
            let consolidation: { count: number; categories: Record<string, number> } | undefined;
            if (teamConfig?.knowledge?.consolidation) {
              const runResult = runs.getRun(teamCtx.team, targetRunId);
              const runId = runResult.found ? runResult.run.id : "unknown";
              consolidation = consolidateLearnings(stores.kv, runId);

              if (consolidation.count > 0) {
                activity.log(teamCtx.team, teamCtx.member, "learning_captured",
                  `Consolidated ${consolidation.count} learning(s) for run ${runId}`, {
                    metadata: { run_id: runId, ...consolidation },
                  });
              }
            }

            // Log run completion
            activity.log(teamCtx.team, teamCtx.member, "run_completed", `Run completed`, {
              metadata: {
                result: params.result?.slice(0, RESULT_PREVIEW_LEN),
                learnings_count: learnings.length,
                run_id: targetRunId,
              },
            });

            await safeSaveAll([runs.save(), stores.kv.save(), activity.save()]);

            // Archive and clean up completed run
            if (targetRunId) {
              await runs.archiveRun(targetRunId);
            }

            // Notify requester about run completion
            notifyRequester(teamCtx.team, `All tasks complete. Run finished with result: "${params.result?.slice(0, RESULT_PREVIEW_LEN) ?? "done"}"`, targetRunId);

            const completeResponse: Record<string, unknown> = {
              status: completeResult.status,
              learnings,
            };
            if (consolidation && consolidation.count > 0) {
              completeResponse.consolidation = consolidation;
            }

            return textResult(completeResponse);
          } catch (err) {
            return errorResult((err as Error).message);
          }
        }

        // ── cancel ────────────────────────────────────────────────────
        case "cancel": {
          try {
            // Resolve runId: explicit param > session-derived > single active
            const targetRunId = params.run_id ?? resolveRunIdFromSession(ctx.sessionKey);
            const cancelResult = runs.cancelRun(teamCtx.team, params.reason, targetRunId);

            if (!cancelResult.ok) {
              return errorResult(`Failed to cancel run for team "${teamCtx.team}".`);
            }

            // Log run cancellation
            activity.log(teamCtx.team, teamCtx.member, "run_canceled",
              `Run canceled: ${params.reason?.slice(0, DESCRIPTION_PREVIEW_LEN) ?? "no reason given"}`, {
                metadata: {
                  reason: params.reason,
                  tasks_canceled: cancelResult.tasks_canceled,
                  run_id: targetRunId,
                },
              });

            await safeSaveAll([runs.save(), activity.save()]);

            // Archive and clean up canceled run
            if (targetRunId) {
              await runs.archiveRun(targetRunId);
            }

            // Notify requester about run cancellation
            notifyRequester(teamCtx.team, `Run canceled: "${params.reason ?? "no reason given"}"`, targetRunId);

            return textResult({
              status: cancelResult.status,
              tasks_canceled: cancelResult.tasks_canceled,
            });
          } catch (err) {
            return errorResult((err as Error).message);
          }
        }

        default:
          return errorResult(`Unknown action: ${params.action}`);
      }
    },
  };
}

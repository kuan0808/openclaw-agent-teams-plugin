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
import { getRegistry, cleanupRunSessions } from "../registry.js";
import { generateTaskChain } from "../workflow/template-engine.js";
import { textResult, errorResult, resolveToolContext, resolveRunIdFromSession, safeSaveAll, countByStatus, collectLearnings, clearLearnings, consolidateLearnings, notifyRequester, DESCRIPTION_PREVIEW_LEN, RESULT_PREVIEW_LEN, type ToolContext } from "./tool-helpers.js";
import { spawnCliIfNeeded } from "./cli-spawn-helper.js";
import { makeAgentId, makeRunSessionKey, isCliMember, type TaskState as TaskStateType } from "../types.js";
import { checkRunLimits, handleEnforcementViolation, shouldOrchestratorAutoComplete, handleOrchestratorAutoComplete } from "../enforcement.js";
import { TERMINAL_TASK_STATES } from "../state/run-manager.js";
import { fmtRunStarted, fmtRunCompleted, fmtRunCanceled } from "../helpers/notification-templates.js";

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
    Type.String({ description: "Team name (required for non-team agents, auto-resolved for at-- agents)" }),
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
      "Manage team execution runs. Requires 'team' parameter. Actions: start (with goal), status, complete, cancel. After starting, follow the REQUIRED_ACTION in the response to activate team agents.",
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

      // ── Lazy enforcement: check run limits on status queries ──────────
      // Only "status" — a new "start" cannot already be timed out.
      if (params.action === "status") {
        const callerRunId = params.run_id ?? resolveRunIdFromSession(ctx.sessionKey);
        const enfRun = runs.getRun(teamCtx.team, callerRunId);
        if (enfRun.found && teamConfig) {
          const violation = checkRunLimits(enfRun.run, teamConfig);
          if (violation) {
            const msg = await handleEnforcementViolation(runs, activity, teamCtx.team, teamCtx.member, enfRun.run, violation);
            return errorResult(msg);
          }
          // Lazy orchestrator auto-complete: if all tasks terminal for > grace period
          if (shouldOrchestratorAutoComplete(enfRun.run, teamConfig)) {
            await handleOrchestratorAutoComplete(runs, activity, teamCtx.team, teamCtx.member, enfRun.run);
          }
        }
      }

      switch (params.action) {
        // ── start ─────────────────────────────────────────────────────
        case "start": {
          if (!params.goal) {
            return errorResult("Parameter 'goal' is required for action=start.");
          }

          // ── Subagent guard: team agents must not start new runs ──
          if (teamCtx.member !== "__leader__") {
            const callerRunId = resolveRunIdFromSession(ctx.sessionKey);
            return errorResult(
              `Team agents cannot start new runs. You are "${teamCtx.member}" — your job is to decompose the goal into tasks using team_task(action: "create"). ` +
              `The run is already active${callerRunId ? ` (${callerRunId})` : ""}. Use team_task to create tasks and assign them to members.`,
            );
          }

          try {
            // ── Active run guard ──────────────────────────────────────
            const workingRuns = runs.getWorkingRuns();
            if (workingRuns.length > 0) {
              const existing = workingRuns[0]!;
              return errorResult(
                `Team "${teamCtx.team}" already has an active run: ${existing.id} (goal: "${existing.goal.slice(0, 100)}"). ` +
                `Complete or cancel it before starting a new one. ` +
                `Use team_run(action: "status", team: "${teamCtx.team}") to check progress.`,
              );
            }

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
                    stores, task.description, result.run_id,
                  );
                }
              }
            }

            await safeSaveAll([runs.save(), stores.kv.save(), activity.save()]);

            // Notify requester that the run has started
            if (teamConfig) {
              const startedRun = runs.getRun(teamCtx.team, result.run_id);
              if (startedRun.found) {
                notifyRequester(teamCtx.team, fmtRunStarted(startedRun.run, teamConfig), result.run_id);
              }
            }

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

              if (orchMember && isCliMember(orchMember)) {
                // CLI orchestrator: spawn via PTY with orchestrator goal as initial task
                try {
                  await spawnCliIfNeeded(
                    registry, teamCtx.team, teamConfig.orchestrator, teamConfig,
                    stores,
                  `You are the orchestrator for team "${teamCtx.team}". Your role is to coordinate — never implement.\n\n` +
                  `STEP 1 — DECOMPOSE: Break the goal into small tasks.\n` +
                  `  Call team_task(action: "create", description: "<specific task>", assign_to: "<member>")\n` +
                  `  for each piece of work. Available members: ${Object.keys(teamConfig.members).filter((k) => k !== teamConfig.orchestrator).join(", ")}.\n\n` +
                  `STEP 2 — VERIFY: Call team_task(action: "query") to confirm all tasks are created.\n\n` +
                  `STEP 3 — MONITOR: Periodically check team_task(action: "query") and team_inbox.\n` +
                  `  - When a task completes, review the result quality.\n` +
                  `  - If revision needed: team_task(action: "update", task_id: "<id>",\n` +
                  `    status: "REVISION_REQUESTED", message: "<specific feedback>")\n` +
                  `  - If acceptable: acknowledge and continue monitoring.\n\n` +
                  `STEP 4 — COMPLETE: When all tasks are done and results are satisfactory,\n` +
                  `  call team_run(action: "complete", result: "<summary of what was built>").\n\n` +
                  `Goal: ${params.goal}`,
                    result.run_id,
                  );
                  response.cli_orchestrator = true;
                  response.note = "CLI orchestrator spawned. It will create tasks and coordinate the team autonomously.";
                } catch (spawnErr) {
                  const msg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
                  activity.log(teamCtx.team, teamConfig.orchestrator, "task_failed",
                    `Failed to spawn CLI orchestrator: ${msg}`, { metadata: { cli: orchMember.cli, error: msg } });
                  await safeSaveAll([activity.save()]);
                  response.cli_orchestrator_error = msg;
                }
              } else if (!orchMember || !isCliMember(orchMember)) {
                const orchRunSessionKey = makeRunSessionKey(orchId, result.run_id);
                response.orchestrator_session = orchRunSessionKey;
                response.REQUIRED_ACTION =
                  `Call: sessions_send({ message: ${JSON.stringify(`Coordinate the team by decomposing the goal into small, finishable tasks: ${params.goal.slice(0, 100)}`)}, sessionKey: ${JSON.stringify(orchRunSessionKey)} })\n` +
                  `Then wait. The team works autonomously. You will receive activation notifications — when you do, call each sessions_send listed in them.`;
                response.WARNING =
                  "Execute the sessions_send call above. When you receive activation notifications, call each listed sessions_send.";
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
                  "Call each sessions_send in next_steps above to activate the peer agents. Do not create tasks — peers handle that themselves.";
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
            const statusResult: Record<string, unknown> = {
              run_id: run.id,
              status: run.status,
              goal: run.goal,
              orchestrator: run.orchestrator ?? null,
              started_at: new Date(run.started_at).toISOString(),
              tasks: countByStatus(run.tasks),
            };

            // Surface unactivated members with PENDING tasks
            if (teamConfig) {
              const pendingActivations: string[] = [];
              const activeButPending: string[] = [];
              const seenMembers = new Set<string>();
              const STALE_SESSION_MS = 120_000; // 2 min — if session registered but tasks still PENDING, treat as stale
              const now = Date.now();
              for (const t of run.tasks) {
                if (!t.assigned_to || t.status !== "PENDING") continue;
                if (seenMembers.has(t.assigned_to)) continue;
                const memberCfg = teamConfig.members[t.assigned_to];
                if (!memberCfg || isCliMember(memberCfg)) continue;
                const aid = makeAgentId(teamCtx.team, t.assigned_to);
                seenMembers.add(t.assigned_to);
                const runSession = registry.memberSessions.get(aid)?.get(runId);
                if (runSession) {
                  // Session exists but may be stale (e.g. sessions_send timed out).
                  // If session was registered > STALE_SESSION_MS ago and tasks are
                  // still PENDING, the subagent likely died — promote to activation.
                  const sessionAge = now - runSession.createdAt;
                  if (sessionAge > STALE_SESSION_MS) {
                    // Stale — treat as needing fresh activation
                    const sk = makeRunSessionKey(aid, runId);
                    const pt = run.tasks.find((tt) => tt.assigned_to === t.assigned_to && tt.status === "PENDING");
                    const desc = pt ? pt.description.slice(0, 80) : "your assigned tasks";
                    pendingActivations.push(
                      `${t.assigned_to}: sessions_send({ message: "You have been assigned: ${desc}. Check team_task(query, filter: mine) for details.", sessionKey: "${sk}" })`,
                    );
                  } else {
                    activeButPending.push(t.assigned_to);
                  }
                  continue;
                }
                const sk = makeRunSessionKey(aid, runId);
                const pt2 = run.tasks.find((tt) => tt.assigned_to === t.assigned_to && tt.status === "PENDING");
                const desc2 = pt2 ? pt2.description.slice(0, 80) : "your assigned tasks";
                pendingActivations.push(
                  `${t.assigned_to}: sessions_send({ message: "You have been assigned: ${desc2}. Check team_task(query, filter: mine) for details.", sessionKey: "${sk}" })`,
                );
              }
              if (pendingActivations.length > 0) {
                statusResult.activate_now = pendingActivations;
                statusResult.INSTRUCTION = `${pendingActivations.length} member(s) need activation. Call each sessions_send command above. This is normal startup — do NOT cancel the run.`;
              }
              if (activeButPending.length > 0) {
                statusResult.agents_starting = `${activeButPending.length} agent(s) have active sessions but tasks are still PENDING — they are starting up.`;
                // Include reactivation commands for stale sessions
                const reactivationCmds: string[] = [];
                for (const memberName of activeButPending) {
                  const aid = makeAgentId(teamCtx.team, memberName);
                  const sk = makeRunSessionKey(aid, runId);
                  const pendingTask = run.tasks.find((t) => t.assigned_to === memberName && t.status === "PENDING");
                  if (pendingTask) {
                    reactivationCmds.push(
                      `${memberName}: sessions_send({ message: "Work on: ${pendingTask.description.slice(0, 80)}", sessionKey: "${sk}" })`,
                    );
                  }
                }
                if (reactivationCmds.length > 0) {
                  statusResult.reactivation_needed = reactivationCmds;
                }
              }
              if (pendingActivations.length === 0 && activeButPending.length === 0) {
                const pendingCount = run.tasks.filter((t) => t.status === "PENDING").length;
                if (pendingCount === 0) {
                  statusResult.note = "All tasks are active or complete. The team is working autonomously.";
                }
              }

              // Check if all tasks are terminal but run is still WORKING
              if (run.status === "WORKING") {
                const allTerminal = run.tasks.length > 0 &&
                  run.tasks.every((t) => TERMINAL_TASK_STATES.has(t.status as TaskStateType));
                if (allTerminal) {
                  const completed = run.tasks.filter((t) => t.status === "COMPLETED").length;
                  const failed = run.tasks.filter((t) => t.status === "FAILED").length;
                  statusResult.pending_completion = {
                    summary: `All ${run.tasks.length} tasks terminal (${completed} completed, ${failed} failed)`,
                    action: `team_run(action: "complete", team: "${teamCtx.team}", result: "Summary of results")`,
                  };
                  statusResult.REQUIRED_ACTION =
                    `All tasks are done. Complete the run: team_run(action: "complete", team: "${teamCtx.team}", result: "<summary of results>")`;
                }
              }
            }

            return textResult(statusResult);
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
            // Re-enter the specific-run branch with the resolved runId
            // so activation directives are included
            const singleRun = allRuns[0]!;
            const redirectParams = { ...params, run_id: singleRun.id };
            const redirectResult = runs.getRun(teamCtx.team, singleRun.id);
            if (redirectResult.found) {
              // Build status with activation checks via the specific-run path
              const run = redirectResult.run;
              const singleResult: Record<string, unknown> = {
                run_id: run.id,
                status: run.status,
                goal: run.goal,
                orchestrator: run.orchestrator ?? null,
                started_at: new Date(run.started_at).toISOString(),
                tasks: countByStatus(run.tasks),
              };

              // Surface unactivated members — same logic as specific-run branch
              if (teamConfig) {
                const pendingActs: string[] = [];
                const activePending: string[] = [];
                const seen = new Set<string>();
                const STALE_MS = 120_000;
                const ts = Date.now();
                for (const t of run.tasks) {
                  if (!t.assigned_to || t.status !== "PENDING") continue;
                  if (seen.has(t.assigned_to)) continue;
                  const mcfg = teamConfig.members[t.assigned_to];
                  if (!mcfg || isCliMember(mcfg)) continue;
                  const aid = makeAgentId(teamCtx.team, t.assigned_to);
                  seen.add(t.assigned_to);
                  const rs = registry.memberSessions.get(aid)?.get(singleRun.id);
                  if (rs) {
                    if (ts - rs.createdAt > STALE_MS) {
                      const sk = makeRunSessionKey(aid, singleRun.id);
                      const pt = run.tasks.find((tt) => tt.assigned_to === t.assigned_to && tt.status === "PENDING");
                      const desc = pt ? pt.description.slice(0, 80) : "your assigned tasks";
                      pendingActs.push(
                        `${t.assigned_to}: sessions_send({ message: "You have been assigned: ${desc}. Check team_task(query, filter: mine) for details.", sessionKey: "${sk}" })`,
                      );
                    } else {
                      activePending.push(t.assigned_to);
                    }
                    continue;
                  }
                  const sk = makeRunSessionKey(aid, singleRun.id);
                  const pt2 = run.tasks.find((tt) => tt.assigned_to === t.assigned_to && tt.status === "PENDING");
                  const desc2 = pt2 ? pt2.description.slice(0, 80) : "your assigned tasks";
                  pendingActs.push(
                    `${t.assigned_to}: sessions_send({ message: "You have been assigned: ${desc2}. Check team_task(query, filter: mine) for details.", sessionKey: "${sk}" })`,
                  );
                }
                if (pendingActs.length > 0) {
                  singleResult.activate_now = pendingActs;
                  singleResult.INSTRUCTION = `${pendingActs.length} member(s) need activation. Call each sessions_send command above. This is normal startup — do NOT cancel the run.`;
                }
                if (activePending.length > 0) {
                  singleResult.agents_starting = `${activePending.length} agent(s) have active sessions but tasks are still PENDING — they are starting up.`;
                  const reacts: string[] = [];
                  for (const mn of activePending) {
                    const aid = makeAgentId(teamCtx.team, mn);
                    const sk = makeRunSessionKey(aid, singleRun.id);
                    const pt = run.tasks.find((t) => t.assigned_to === mn && t.status === "PENDING");
                    if (pt) {
                      reacts.push(`${mn}: sessions_send({ message: "Work on: ${pt.description.slice(0, 80)}", sessionKey: "${sk}" })`);
                    }
                  }
                  if (reacts.length > 0) {
                    singleResult.reactivation_needed = reacts;
                  }
                }
                // Check all-terminal pending completion
                if (run.status === "WORKING") {
                  const allTerminal = run.tasks.length > 0 &&
                    run.tasks.every((t) => TERMINAL_TASK_STATES.has(t.status as TaskStateType));
                  if (allTerminal) {
                    const completed = run.tasks.filter((t) => t.status === "COMPLETED").length;
                    const failed = run.tasks.filter((t) => t.status === "FAILED").length;
                    singleResult.pending_completion = {
                      summary: `All ${run.tasks.length} tasks terminal (${completed} completed, ${failed} failed)`,
                      action: `team_run(action: "complete", team: "${teamCtx.team}", result: "Summary of results")`,
                    };
                    singleResult.REQUIRED_ACTION =
                      `All tasks are done. Complete the run: team_run(action: "complete", team: "${teamCtx.team}", result: "<summary of results>")`;
                  }
                }
              }

              return textResult(singleResult);
            }
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

            // Notify requester and capture session before archiving (archiveRun removes the run)
            const runBeforeArchive = runs.getRun(teamCtx.team, targetRunId);
            if (runBeforeArchive.found) {
              notifyRequester(teamCtx.team, fmtRunCompleted(runBeforeArchive.run, params.result ?? "done"), targetRunId);
            } else {
              notifyRequester(teamCtx.team, `Run completed: ${targetRunId}`, targetRunId);
            }
            const requesterSession = runBeforeArchive.found ? runBeforeArchive.run.requester_session : undefined;

            // Archive and clean up completed run
            if (targetRunId) {
              await runs.archiveRun(targetRunId);
              cleanupRunSessions(registry, targetRunId);
            }

            const completeResponse: Record<string, unknown> = {
              status: completeResult.status,
              learnings,
            };
            if (consolidation && consolidation.count > 0) {
              completeResponse.consolidation = consolidation;
            }
            if (requesterSession && teamCtx.member !== "__leader__") {
              const resultPreview = params.result?.slice(0, 200) ?? "done";
              completeResponse.REQUIRED_ACTION =
                `Report completion to user: sessions_send({ message: ${JSON.stringify(`[${teamCtx.team} Team] Run completed: ${resultPreview}`)}, sessionKey: ${JSON.stringify(requesterSession)} })`;
            }

            return textResult(completeResponse);
          } catch (err) {
            const msg = (err as Error).message;
            // If run was already auto-completed or archived, return a friendly status
            if (msg.includes("not found") || msg.includes("already")) {
              return textResult({
                status: "already_completed",
                message: "This run was already completed. No further action needed.",
              });
            }
            return errorResult(msg);
          }
        }

        // ── cancel ────────────────────────────────────────────────────
        case "cancel": {
          // Team agents (subagents) must not cancel runs
          if (teamCtx.member !== "__leader__") {
            if (teamConfig?.orchestrator === teamCtx.member) {
              return errorResult(
                `As the orchestrator, use team_run(action: "complete") to finish the run when all tasks are done. ` +
                `Do not cancel runs — decompose the goal into tasks using team_task(action: "create") instead.`,
              );
            }
            return errorResult(
              `Only the main agent can cancel runs. You are "${teamCtx.member}" — focus on completing your assigned tasks.`,
            );
          }

          try {
            // Resolve runId: explicit param > session-derived > single active
            const targetRunId = params.run_id ?? resolveRunIdFromSession(ctx.sessionKey);

            // Guard: warn against premature cancellation
            const cancelTargetRun = runs.getRun(teamCtx.team, targetRunId);
            if (cancelTargetRun.found && cancelTargetRun.run.status === "WORKING") {
              const runAgeMs = Date.now() - cancelTargetRun.run.started_at;
              const workingTasks = cancelTargetRun.run.tasks.filter((t) => t.status === "WORKING").length;
              if (runAgeMs < 300_000 && workingTasks > 0) {
                return errorResult(
                  `Run "${cancelTargetRun.run.id}" has ${workingTasks} task(s) actively being worked on and has only been running for ${Math.round(runAgeMs / 1000)}s. ` +
                  `Canceling now would lose that work. Team runs typically need 3-10 minutes to complete. ` +
                  `Use team_run(action: "status") to check progress instead.`,
                );
              }
            }

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

            // Log individual task cancellations for audit trail (1F)
            const canceledRun = targetRunId ? runs.getRun(teamCtx.team, targetRunId) : runs.getRun(teamCtx.team);
            if (canceledRun.found) {
              for (const task of canceledRun.run.tasks) {
                if (task.status === "CANCELED") {
                  activity.log(teamCtx.team, teamCtx.member, "task_canceled",
                    `Task canceled due to run cancellation: ${task.description.slice(0, DESCRIPTION_PREVIEW_LEN)}`, {
                      target_id: task.id,
                      metadata: {
                        reason: params.reason ?? "run cancellation",
                      },
                    });
                }
              }
            }

            await safeSaveAll([runs.save(), activity.save()]);

            // Archive and clean up canceled run
            if (targetRunId) {
              await runs.archiveRun(targetRunId);
              cleanupRunSessions(registry, targetRunId);
            }

            // Notify requester about run cancellation (reuse canceledRun from audit trail above)
            if (canceledRun.found) {
              notifyRequester(teamCtx.team, fmtRunCanceled(canceledRun.run, params.reason ?? "no reason given"), targetRunId);
            } else {
              notifyRequester(teamCtx.team, `Run canceled: "${params.reason ?? "no reason given"}"`, targetRunId);
            }

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

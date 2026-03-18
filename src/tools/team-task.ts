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
import { getRegistry, resolveAgentSession } from "../registry.js";
import { resolveDependencies, shouldBlock, detectCycle, cascadeCancelDependents } from "../routing/dependency-resolver.js";
import { routeTask } from "../routing/task-dispatcher.js";
import { handleFailLoopback } from "../workflow/template-engine.js";
import { shouldAutoComplete } from "../patterns/peer.js";
import { checkRunLimits, handleEnforcementViolation, shouldOrchestratorAutoComplete, handleOrchestratorAutoComplete } from "../enforcement.js";
import type {
  TaskState,
  TeamConfig,
  TeamTask,
  DeliverableEntry,
  StructuredLearning,
  LearningCategory,
  GateConfig,
} from "../types.js";
import { makeAgentId, makeRunSessionKey, isCliMember, getCliCwd, type TaskState as TaskStateType } from "../types.js";
import { textResult, errorResult, resolveToolContext, resolveRunIdFromSession, safeSaveAll, notifyRequester, requireTeamAgent, LEARNINGS_KEY_PREFIX, DESCRIPTION_PREVIEW_LEN, wakeActiveNativeAssignee, countByStatus, type ToolContext } from "./tool-helpers.js";
import { spawnCliIfNeeded } from "./cli-spawn-helper.js";
import { validateTransition, TERMINAL_TASK_STATES, ACTIVE_TASK_STATES } from "../state/run-manager.js";
import { fmtTaskAssigned, fmtTaskCompleted, fmtTaskFailed, fmtRevisionRequested, fmtRunCompleted } from "../helpers/notification-templates.js";

// ── Parameters ──────────────────────────────────────────────────────────

const TASK_STATES: TaskState[] = [
  "BLOCKED",
  "PENDING",
  "WORKING",
  "INPUT_REQUIRED",
  "COMPLETED",
  "FAILED",
  "CANCELED",
  "REVISION_REQUESTED",
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
  filter: Type.Optional(
    Type.Union(
      [Type.Literal("mine"), Type.Literal("unassigned"), Type.Literal("available")],
      { description: "Filter tasks: 'mine' (assigned to me), 'unassigned' (no assignee), 'available' (PENDING tasks I could claim)" },
    ),
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
      "Create, update, and query tasks within a team run. Requires 'team' parameter for non-team agents. Task creation is typically done by team agents — start a run with team_run first.",
    parameters: Parameters,

    async execute(
      _toolCallId: string,
      params: Params,
      _signal?: AbortSignal,
    ) {
      // Main agent should delegate to team agents, not call team_task directly
      const guard = requireTeamAgent(ctx.agentId, "team_task");
      if (guard) return guard;

      const resolved = resolveToolContext(ctx.agentId, params.team);
      if (!resolved.ok) return resolved.error;
      const { teamCtx, stores } = resolved;

      const { runs, activity } = stores;
      const registry = getRegistry();
      const teamConfig = registry.getTeamConfig(teamCtx.team);

      // ── Lazy enforcement: check run limits before any mutation ───────
      if (params.action === "create" || params.action === "update") {
        const callerRunId = resolveRunIdFromSession(ctx.sessionKey);
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
        // ── create ────────────────────────────────────────────────────
        case "create": {
          if (!params.description) {
            return errorResult("Parameter 'description' is required for action=create.");
          }

          if (teamCtx.member === "__leader__" && teamConfig?.coordination === "peer") {
            return errorResult(
              `Peer-mode tasks must be created by peer members, not the main session. Start a run with team_run(action: "start") first, then send messages to peer agents via sessions_send.`,
            );
          }

          if (
            teamCtx.member === "__leader__" &&
            teamConfig?.coordination === "orchestrator" &&
            teamConfig.orchestrator
          ) {
            return errorResult(
              `Orchestrator-mode tasks must be created by the orchestrator agent, not the main session. Start a run with team_run(action: "start") first — it will return a sessions_send directive.`,
            );
          }

          // Resolve runId from caller's session or fallback to single active run
          const callerRunId = resolveRunIdFromSession(ctx.sessionKey);
          const currentRun = runs.getRun(teamCtx.team, callerRunId);
          if (!currentRun.found) {
            return errorResult(
              `No active run for team "${teamCtx.team}". Start a run first with team_run action=start.`,
            );
          }
          const effectiveRunId = currentRun.run.id;

          const existingTasks = runs.listTasks(teamCtx.team, undefined, effectiveRunId);

          // Route the task
          const routing = routeTask(
            teamConfig!,
            params.description,
            params.assign_to,
            params.required_skills,
            teamCtx.member,
            existingTasks,
          );

          if (teamConfig?.coordination === "peer" && routing.assigned_to === teamCtx.member) {
            const activeOwnTasks = existingTasks.filter(
              (task) =>
                task.assigned_to === teamCtx.member &&
                ACTIVE_TASK_STATES.has(task.status as TaskState),
            );

            if (activeOwnTasks.length > 0) {
              const activeTaskPreview = activeOwnTasks
                .slice(0, 3)
                .map((task) => task.id)
                .join(", ");
              const overflow =
                activeOwnTasks.length > 3 ? ` and ${activeOwnTasks.length - 3} more` : "";
              return errorResult(
                `Finish or update your active peer tasks before creating another task for yourself. Use team_task(action: "query", filter: "mine") to review your current work, or assign the new task to a different peer explicitly. Active tasks: ${activeTaskPreview}${overflow}.`,
              );
            }
          }

          const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

          // Resolve depends_on references — LLMs may use various formats:
          //   - Full task IDs ("task-1234-abc")
          //   - 1-based indices ("1", "2")
          //   - Partial IDs (suffix match)
          //   - Symbolic names like "TASK_BACKEND", "backend_task" (member-name match)
          let resolvedDeps = params.depends_on;
          if (resolvedDeps?.length) {
            const taskIdSet = new Set(existingTasks.map((t) => t.id));
            resolvedDeps = resolvedDeps.map((dep) => {
              if (taskIdSet.has(dep)) return dep; // exact match
              // Try 1-based index into existing run tasks
              const idx = parseInt(dep, 10);
              if (!isNaN(idx) && idx >= 1 && idx <= existingTasks.length) {
                return existingTasks[idx - 1].id;
              }
              // Try partial ID match (suffix)
              const suffixMatch = existingTasks.find((t) => t.id.endsWith(dep));
              if (suffixMatch) return suffixMatch.id;
              // Try member-name match (e.g. "TASK_BACKEND" → task assigned to "backend")
              const depLower = dep.toLowerCase().replace(/[^a-z0-9]/g, "");
              const memberMatch = existingTasks.find((t) => {
                if (!t.assigned_to) return false;
                const memberLower = t.assigned_to.toLowerCase().replace(/[^a-z0-9]/g, "");
                return depLower.includes(memberLower) || memberLower.includes(depLower);
              });
              if (memberMatch) return memberMatch.id;
              return dep; // return as-is; will cause BLOCKED until manually resolved
            });
          }

          // Check for circular dependencies
          if (resolvedDeps?.length) {
            const cycle = detectCycle(existingTasks, taskId, resolvedDeps);
            if (cycle) {
              return errorResult(`Circular dependency detected: ${cycle.join(" → ")}`);
            }
          }

          // Determine initial status based on dependencies
          const initialStatus: TaskState =
            resolvedDeps?.length && shouldBlock(existingTasks, resolvedDeps)
              ? "BLOCKED"
              : "PENDING";

          let task = runs.addTask(teamCtx.team, {
            id: taskId,
            team: teamCtx.team,
            run_id: effectiveRunId,
            description: params.description,
            assigned_to: routing.assigned_to,
            status: initialStatus,
            depends_on: resolvedDeps,
            routing_reason: routing.routing_reason,
          });

          // Log activity
          activity.log(teamCtx.team, teamCtx.member, "task_created", `Task created: ${params.description.slice(0, DESCRIPTION_PREVIEW_LEN)}`, {
            target_id: taskId,
            metadata: {
              assigned_to: task.assigned_to,
              status: task.status,
              routing_reason: task.routing_reason,
            },
          });
          await safeSaveAll([runs.save(), activity.save()]);

          // Notify requester about task assignment
          if (effectiveRunId) {
            const currentRunSnap = runs.getRun(teamCtx.team, effectiveRunId);
            if (currentRunSnap.found) {
              notifyRequester(
                teamCtx.team,
                fmtTaskAssigned(task, currentRunSnap.run, routing.routing_reason),
                effectiveRunId,
              );
            }
          }

          // Trigger CLI agent spawn on task assignment
          if (task.assigned_to && teamConfig) {
            await spawnCliIfNeeded(
              registry, teamCtx.team, task.assigned_to, teamConfig,
              stores, params.description, effectiveRunId,
            );
          }

          if (task.assigned_to && teamConfig) {
            const assigneeMemberConfig = teamConfig.members[task.assigned_to];
            if (assigneeMemberConfig && !isCliMember(assigneeMemberConfig)) {
              await wakeActiveNativeAssignee(teamCtx.team, task, stores);
              const latestTask = runs.getTask(teamCtx.team, task.id);
              if (latestTask) {
                task = latestTask;
              }
            }
          }

          const createResult: Record<string, unknown> = {
            task_id: task.id,
            assigned_to: task.assigned_to ?? null,
            status: task.status,
            routing_reason: task.routing_reason ?? null,
          };

          // Include existing task IDs so orchestrator can reference them in depends_on
          if (existingTasks.length > 0) {
            createResult.existing_tasks = existingTasks.map((t, i) => ({
              index: i + 1,
              task_id: t.id,
              assigned_to: t.assigned_to,
            }));
            createResult.depends_on_hint = "Use task_id values (or 1-based index numbers) in depends_on, NOT symbolic names.";
          }

          // Add session directive for native (non-CLI) members
          if (task.assigned_to && teamConfig) {
            const assigneeMemberConfig = teamConfig.members[task.assigned_to];
            if (assigneeMemberConfig && !isCliMember(assigneeMemberConfig)) {
              const agentId = makeAgentId(teamCtx.team, task.assigned_to);
              const assigneeRunSessionKey = makeRunSessionKey(agentId, effectiveRunId);

              // Check if member already has an active session for this run
              const runSessions = registry.memberSessions.get(agentId);
              const hasRunSession = runSessions?.has(effectiveRunId);

              if (hasRunSession) {
                createResult.active_session = true;
                // Poke the assignee — their session exists but may be idle
                // (e.g. initial sessions_send timed out). This transitions
                // PENDING → WORKING and sends a system event to their session.
                await wakeActiveNativeAssignee(teamCtx.team, task, stores);
              } else {
                createResult.requires_session = true;
                createResult.send_action =
                  `Call sessions_send({ message: ${JSON.stringify(`Work on: ${params.description.slice(0, DESCRIPTION_PREVIEW_LEN)}`)}, sessionKey: ${JSON.stringify(assigneeRunSessionKey)} }) to activate this agent for the current run.`;
              }
            }
          }

          // Collect ALL unactivated native members for this run and send
          // a single consolidated activation request to the main agent.
          // This ensures all activations are in one message, not scattered.
          {
            const allRunTasks = runs.listTasks(teamCtx.team, undefined, effectiveRunId);
            const activationCmds: string[] = [];
            const seenMembers = new Set<string>();
            for (const t of allRunTasks) {
              if (!t.assigned_to || t.status !== "PENDING") continue;
              if (seenMembers.has(t.assigned_to)) continue;
              const memberCfg = teamConfig?.members[t.assigned_to];
              if (!memberCfg || isCliMember(memberCfg)) continue;
              const aid = makeAgentId(teamCtx.team, t.assigned_to);
              if (registry.memberSessions.get(aid)?.has(effectiveRunId)) continue;
              seenMembers.add(t.assigned_to);
              const sk = makeRunSessionKey(aid, effectiveRunId);
              const pendingTask = allRunTasks.find((tt) => tt.assigned_to === t.assigned_to && tt.status === "PENDING");
              const taskDesc = pendingTask ? pendingTask.description.slice(0, 80) : "your assigned tasks";
              activationCmds.push(
                `sessions_send({ message: "You have been assigned: ${taskDesc}. Check team_task(query, filter: mine) for details.", sessionKey: "${sk}" })`,
              );
            }
            if (activationCmds.length > 0) {
              createResult.pending_activations = activationCmds.length;
              createResult.REQUIRED_ACTION =
                `${activationCmds.length} agent(s) need activation. Call each one:\n` +
                activationCmds.map((cmd, i) => `${i + 1}. ${cmd}`).join("\n");
              const activationMsg =
                `[Action Required] ${activationCmds.length} team member(s) need activation. Call each sessions_send:\n` +
                activationCmds.map((cmd, i) => `${i + 1}. ${cmd}`).join("\n");
              // Send to the caller's session (orchestrator or peer)
              if (ctx.sessionKey) {
                registry.enqueueSystemEvent(activationMsg, { sessionKey: ctx.sessionKey });
                registry.requestHeartbeatNow({ sessionKey: ctx.sessionKey });
              }
              // Also notify the requester (Main Agent) as backup — the creating peer
              // may not follow REQUIRED_ACTION, so the Main Agent can activate on status check.
              const currentRun = runs.getRun(teamCtx.team, effectiveRunId);
              if (currentRun.found && currentRun.run.requester_session &&
                  currentRun.run.requester_session !== ctx.sessionKey) {
                registry.enqueueSystemEvent(activationMsg, { sessionKey: currentRun.run.requester_session });
                registry.requestHeartbeatNow({ sessionKey: currentRun.run.requester_session });
              }
            }
          }

          return textResult(createResult);
        }

        // ── update ────────────────────────────────────────────────────
        case "update": {
          if (!params.task_id) {
            return errorResult("Parameter 'task_id' is required for action=update.");
          }

          // Guard: main agent should not update tasks on orchestrator teams
          if (
            teamCtx.member === "__leader__" &&
            teamConfig?.coordination === "orchestrator" &&
            teamConfig.orchestrator
          ) {
            return errorResult(
              `Task updates on orchestrator teams must come from team agents, not the main session. ` +
              `The orchestrator (${teamConfig.orchestrator}) and team members handle task execution. ` +
              `Use team_run(action: "status") to monitor progress instead.`,
            );
          }

          const existing = runs.getTask(teamCtx.team, params.task_id);
          if (!existing) {
            return errorResult(`Task "${params.task_id}" not found in team "${teamCtx.team}".`);
          }

          // Resolve the run this task belongs to
          const taskRunId = existing.run_id;

          if (params.status && existing.depends_on?.length) {
            const allTasks = runs.listTasks(teamCtx.team, undefined, taskRunId);
            const completedIds = new Set(
              allTasks
                .filter((task) => task.status === "COMPLETED")
                .map((task) => task.id),
            );
            const unresolvedDeps = existing.depends_on.filter((dep) => !completedIds.has(dep));

            if (
              unresolvedDeps.length > 0 &&
              params.status !== "BLOCKED" &&
              params.status !== "CANCELED"
            ) {
              return errorResult(
                `Cannot move task forward while dependencies are unresolved. Complete dependencies first: ${unresolvedDeps.join(", ")}`,
              );
            }
          }

          // ── Task state machine validation ─────────────────────────
          if (params.status) {
            const transitionError = validateTransition(existing.status, params.status as TaskState);
            if (transitionError) {
              return errorResult(transitionError);
            }
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

          // ── REVISION_REQUESTED guard & post-transition ─────────────
          if (params.status === "REVISION_REQUESTED") {
            // Only orchestrator (or configured reviewer) can request revision
            const reviewerGate = teamConfig?.workflow?.gates?.["REVISION_REQUESTED"]?.reviewer;
            const requiredReviewer = reviewerGate === "orchestrator"
              ? teamConfig?.orchestrator
              : reviewerGate ?? teamConfig?.orchestrator;
            if (requiredReviewer && teamCtx.member !== requiredReviewer && teamCtx.member !== "__leader__") {
              return errorResult(
                `Only "${requiredReviewer}" can request revisions. Current caller: "${teamCtx.member}".`,
              );
            }

            // Feedback message required
            if (!params.message) {
              return errorResult(
                `Revision feedback is required. Provide 'message' parameter with detailed feedback on what needs to change.`,
              );
            }

            // Leaf-task constraint: reject if task has active (non-terminal) dependents
            const allTasks = runs.listTasks(teamCtx.team, undefined, taskRunId);
            const hasActiveDependents = allTasks.some(
              (t) => t.depends_on?.includes(params.task_id!) && ACTIVE_TASK_STATES.has(t.status as TaskState),
            );
            if (hasActiveDependents) {
              return errorResult(
                `Cannot request revision: task has active dependents. Only leaf tasks (no active downstream tasks) can be sent for revision.`,
              );
            }

            // Post-transition: increment revision_count, store feedback, bump round_count
            const revisionCount = (existing.revision_count ?? 0) + 1;
            runs.updateTask(teamCtx.team, params.task_id!, {
              status: "REVISION_REQUESTED" as TaskState,
              revision_count: revisionCount,
              revision_feedback: params.message,
              message: params.message,
            });

            // Increment round_count (max_rounds enforcement)
            runs.incrementRoundCount(teamCtx.team, taskRunId);

            // Reset all_terminal_at (prevents premature auto-complete)
            const currentRun = runs.getRun(teamCtx.team, taskRunId);
            if (currentRun.found && currentRun.run.all_terminal_at) {
              currentRun.run.all_terminal_at = undefined;
              currentRun.run.updated_at = Date.now();
            }

            // Notify worker: system event + heartbeat
            if (existing.assigned_to && teamConfig) {
              const workerAgentId = makeAgentId(teamCtx.team, existing.assigned_to);
              const workerSk = resolveAgentSession(registry, workerAgentId, taskRunId);
              if (workerSk) {
                registry.enqueueSystemEvent(
                  `[Revision Requested] Task ${params.task_id} needs revision: ${params.message.slice(0, 200)}. Address the feedback and resubmit as COMPLETED.`,
                  { sessionKey: workerSk },
                );
                registry.requestHeartbeatNow({ agentId: workerAgentId, sessionKey: workerSk });
              }

              // For CLI workers: respawn with revision prompt
              const memberConfig = teamConfig.members[existing.assigned_to];
              if (memberConfig && isCliMember(memberConfig)) {
                const revisionPrompt = `REVISION REQUESTED for task ${params.task_id}: ${params.message}. Original task: ${existing.description}`;
                await spawnCliIfNeeded(
                  registry, teamCtx.team, existing.assigned_to, teamConfig,
                  stores, revisionPrompt, taskRunId,
                );
              }
            }

            // Log activity
            activity.log(teamCtx.team, teamCtx.member, "task_revision_requested",
              `Revision requested: ${existing.description.slice(0, DESCRIPTION_PREVIEW_LEN)}`, {
                target_id: params.task_id,
                metadata: {
                  revision_count: revisionCount,
                  feedback: params.message.slice(0, 200),
                },
              });

            await safeSaveAll([runs.save(), activity.save()]);

            // Progress push to requester
            if (taskRunId) {
              notifyRequester(teamCtx.team,
                fmtRevisionRequested(existing, taskRunId, teamCtx.member, params.message, revisionCount),
                taskRunId);
            }

            return textResult({
              task_id: params.task_id,
              status: "REVISION_REQUESTED",
              revision_count: revisionCount,
              assigned_to: existing.assigned_to ?? null,
              feedback: params.message,
            });
          }

          // ── REVISION_REQUESTED → WORKING (worker picks up) ─────────
          const isRevisionPickup = params.status === "WORKING" && existing.status === "REVISION_REQUESTED";
          if (isRevisionPickup) {
            activity.log(teamCtx.team, teamCtx.member, "task_revision_restarted",
              `Revision restarted: ${existing.description.slice(0, DESCRIPTION_PREVIEW_LEN)}`, {
                target_id: params.task_id,
                metadata: { revision_count: existing.revision_count },
              });
          }

          const updates: Partial<Pick<TeamTask, "status" | "result" | "message" | "assigned_to" | "deliverables" | "learning" | "revision_feedback">> = {};
          // Clear revision_feedback when worker picks up revision
          if (isRevisionPickup) {
            updates.revision_feedback = "";
          }

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

              // Notify leader about new learning if configured
              if (teamConfig?.knowledge?.notify_leader && teamConfig.orchestrator) {
                stores.messages.push(
                  teamCtx.member,
                  teamConfig.orchestrator,
                  `New learning [${learning.category}]: ${learning.content.slice(0, 120)}`,
                );
              }
            }
          }

          const updated = runs.updateTask(teamCtx.team, params.task_id, updates);
          if (!updated) {
            return errorResult(`Failed to update task "${params.task_id}".`);
          }

          // If task was completed, resolve blocked dependencies
          let unblockedTasks: string[] = [];
          let reactivationAction: string | undefined;
          let completionAction: string | undefined;
          if (params.status === "COMPLETED") {
            const allTasks = runs.listTasks(teamCtx.team, undefined, taskRunId);
            const unblocked = resolveDependencies(allTasks, params.task_id);
            unblockedTasks = unblocked.map((t) => t.id);

            if (unblockedTasks.length > 0) {
              activity.log(teamCtx.team, teamCtx.member, "dependency_resolved",
                `Unblocked ${unblockedTasks.length} task(s)`, {
                  target_id: params.task_id,
                  metadata: { unblocked: unblockedTasks },
                });

              if (teamConfig) {
                const reactivationCmds: string[] = [];
                for (const task of unblocked) {
                  if (!task.assigned_to) continue;
                  const assigneeMemberConfig = teamConfig.members[task.assigned_to];
                  if (assigneeMemberConfig && !isCliMember(assigneeMemberConfig)) {
                    // Try to wake active session (transitions PENDING→WORKING + heartbeat)
                    await wakeActiveNativeAssignee(teamCtx.team, task, stores);
                    // ALWAYS request re-activation via sessions_send as well.
                    // Heartbeats alone often fail to wake idle/stale sessions —
                    // sessions_send provides fresh context and guaranteed delivery.
                    const aid = makeAgentId(teamCtx.team, task.assigned_to);
                    const sk = makeRunSessionKey(aid, taskRunId ?? "unknown");
                    reactivationCmds.push(
                      `sessions_send({ message: "Your task ${task.id} is now unblocked. Start working on: ${task.description.slice(0, 100)}", sessionKey: "${sk}" })`,
                    );
                  }
                }
                if (reactivationCmds.length > 0) {
                  // Store for later assignment to result object
                  reactivationAction =
                    `${reactivationCmds.length} member(s) unblocked by your task completion. Activate them:\n` +
                    reactivationCmds.map((cmd, i) => `${i + 1}. ${cmd}`).join("\n");
                }
              }
            }

            // Log task completion
            activity.log(teamCtx.team, teamCtx.member, "task_completed",
              `Task completed: ${existing.description.slice(0, DESCRIPTION_PREVIEW_LEN)}`, {
                target_id: params.task_id,
              });
          }

          // ── Workflow fail-loopback handling ─────────────────────────
          let loopbackResult: Record<string, unknown> | undefined;
          if (params.status === "FAILED" && teamConfig?.workflow?.template && existing.workflow_stage) {
            const allTasks = runs.listTasks(teamCtx.team, undefined, taskRunId);
            const runId = taskRunId ?? "unknown";

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

              // Spawn CLI agent for rework task if needed
              if (reworkTask.assigned_to && teamConfig) {
                await spawnCliIfNeeded(
                  registry, teamCtx.team, reworkTask.assigned_to, teamConfig,
                  stores, reworkTask.description, taskRunId,
                );
              }
            }
          }

          // ── Cascade cancel dependents on FAILED/CANCELED (1B) ──────
          if (params.status === "FAILED" || params.status === "CANCELED") {
            const allTasks = runs.listTasks(teamCtx.team, undefined, taskRunId);
            const cascaded = cascadeCancelDependents(allTasks, params.task_id);
            for (const ct of cascaded) {
              activity.log(teamCtx.team, teamCtx.member, "dependency_cascaded",
                `Cascade-canceled: ${ct.id} (dependency on ${params.task_id})`, {
                  target_id: ct.id,
                  metadata: { root_task: params.task_id, message: ct.message },
                });
            }
          }

          // ── Increment round_count on fail-loopback (1C) ──────────
          if (loopbackResult && taskRunId) {
            runs.incrementRoundCount(teamCtx.team, taskRunId);
          }

          // Log status-specific activity (after loopback handling)
          if (params.status === "FAILED") {
            activity.log(teamCtx.team, teamCtx.member, "task_failed",
              `Task failed: ${existing.description.slice(0, DESCRIPTION_PREVIEW_LEN)}`, {
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

          await safeSaveAll([runs.save(), stores.kv.save(), stores.messages.save(), activity.save()]);

          // ── Progress push + auto-complete when tasks reach terminal ──
          if (params.status && TERMINAL_TASK_STATES.has(params.status as TaskStateType) && taskRunId) {
            const teamName = teamCtx.team;
            const currentRun = runs.getRun(teamName, taskRunId);

            // Progress push on task completion/failure
            if (currentRun.found) {
              if (params.status === "COMPLETED") {
                notifyRequester(teamName,
                  fmtTaskCompleted(existing, currentRun.run, typeof params.result === "string" ? params.result : undefined),
                  taskRunId);
              } else if (params.status === "FAILED") {
                notifyRequester(teamName,
                  fmtTaskFailed(existing, currentRun.run, typeof params.message === "string" ? params.message : undefined),
                  taskRunId);
              }
            }

            // Auto-complete / notify when all tasks terminal
            if (currentRun.found && currentRun.run.status === "WORKING") {
              const allTerminal = currentRun.run.tasks.length > 0 &&
                currentRun.run.tasks.every((t) => TERMINAL_TASK_STATES.has(t.status as TaskStateType));

              if (allTerminal) {
                // Record when all tasks first became terminal (for lazy auto-complete)
                if (!currentRun.run.all_terminal_at) {
                  currentRun.run.all_terminal_at = Date.now();
                  currentRun.run.updated_at = Date.now();
                  await safeSaveAll([runs.save()]);
                }

                const allCompleted = currentRun.run.tasks.every((t) => t.status === "COMPLETED");
                if (teamConfig?.coordination === "peer") {
                  // Peer mode: auto-complete
                  const autoComplete = shouldAutoComplete(currentRun.run);
                  if (autoComplete) {
                    try {
                      runs.completeRun(teamName,
                        autoComplete.allCompleted ? "All tasks completed" : "All tasks reached terminal state",
                        currentRun.run.id);
                      activity.log(teamName, teamCtx.member, "run_completed",
                        "Auto-completed: all tasks in terminal state (peer mode)", {
                          target_id: currentRun.run.id,
                          metadata: { auto_complete: true, all_completed: autoComplete.allCompleted },
                        });
                      notifyRequester(teamName,
                        fmtRunCompleted(currentRun.run, autoComplete.allCompleted ? "All tasks completed" : "All tasks reached terminal state"),
                        currentRun.run.id);
                      await safeSaveAll([runs.save(), activity.save()]);
                    } catch { /* run may already be completed */ }
                  }
                } else if (teamConfig?.orchestrator && taskRunId) {
                  // Orchestrator mode: notify orchestrator via REQUIRED_ACTION + sessions_send
                  const statusSummary = allCompleted
                    ? `All ${currentRun.run.tasks.length} tasks COMPLETED successfully.`
                    : `All ${currentRun.run.tasks.length} tasks reached terminal state (some may have failed).`;
                  const orchId = makeAgentId(teamName, teamConfig.orchestrator);
                  const orchSk = makeRunSessionKey(orchId, taskRunId);

                  // Primary: tell completing worker to notify orchestrator via sessions_send
                  completionAction =
                    `All tasks finished. Notify the orchestrator to review and complete the run:\n` +
                    `sessions_send({ message: "${statusSummary} Review results and call team_run(action: complete) to finalize.", sessionKey: "${orchSk}" })`;

                  // Backup: fire-and-forget system event to orchestrator
                  registry.enqueueSystemEvent(
                    `[${teamName} Team] [Action Required] ${statusSummary} Complete the run:\n` +
                    `team_run(action: "complete", team: "${teamName}", result: "<summary of results>")`,
                    { sessionKey: orchSk },
                  );
                  registry.requestHeartbeatNow({ sessionKey: orchSk });
                }
              }
            }
          }

          // Trigger CLI agent spawn when task is reassigned
          if (params.assign_to && teamConfig) {
            await spawnCliIfNeeded(
              registry, teamCtx.team, params.assign_to, teamConfig,
              stores, existing.description, taskRunId,
            );

            const assigneeMemberConfig = teamConfig.members[params.assign_to];
            if (assigneeMemberConfig && !isCliMember(assigneeMemberConfig)) {
              await wakeActiveNativeAssignee(teamCtx.team, updated, stores);
            }
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

          if (reactivationAction) {
            result.REQUIRED_ACTION = reactivationAction;
          }

          if (completionAction && !result.REQUIRED_ACTION) {
            result.REQUIRED_ACTION = completionAction;
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
          // Resolve runId for scoped queries: callers in a run session only see their run's tasks
          const queryRunId = resolveRunIdFromSession(ctx.sessionKey);
          let tasks = runs.listTasks(teamCtx.team, params.filter_status, queryRunId);

          // Apply convenience filter
          if (params.filter) {
            switch (params.filter) {
              case "mine":
                tasks = tasks.filter((t) => t.assigned_to === teamCtx.member);
                break;
              case "unassigned":
                tasks = tasks.filter((t) => !t.assigned_to);
                break;
              case "available":
                tasks = tasks.filter(
                  (t) => t.status === "PENDING" && (!t.assigned_to || t.assigned_to === teamCtx.member),
                );
                break;
            }
          }

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

          const queryResult: Record<string, unknown> = {
            team: teamCtx.team,
            count: taskList.length,
            tasks: taskList,
          };

          // For orchestrators: surface pending activations in query results
          if (teamConfig?.coordination === "orchestrator" && teamConfig.orchestrator === teamCtx.member) {
            const allQueryTasks = runs.listTasks(teamCtx.team, undefined, queryRunId);
            const pendingNeedingActivation: string[] = [];
            const seenMembers2 = new Set<string>();
            for (const t of allQueryTasks) {
              if (!t.assigned_to || t.status !== "PENDING") continue;
              if (seenMembers2.has(t.assigned_to)) continue;
              const memberCfg = teamConfig.members[t.assigned_to];
              if (!memberCfg || isCliMember(memberCfg)) continue;
              const aid = makeAgentId(teamCtx.team, t.assigned_to);
              if (registry.memberSessions.get(aid)?.has(t.run_id)) continue;
              seenMembers2.add(t.assigned_to);
              const sk = makeRunSessionKey(aid, t.run_id);
              const taskDesc = t.description.slice(0, 80);
              pendingNeedingActivation.push(
                `${t.assigned_to}: sessions_send({ message: "You have been assigned: ${taskDesc}. Check team_task(query, filter: mine) for details.", sessionKey: "${sk}" })`,
              );
            }
            if (pendingNeedingActivation.length > 0) {
              queryResult.WARNING = `${pendingNeedingActivation.length} member(s) have PENDING tasks but no active session. Activate them NOW:`;
              queryResult.activate_now = pendingNeedingActivation;
            }
          }

          return textResult(queryResult);
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

  // Check reviewer (for REVISION_REQUESTED)
  if (gate.reviewer) {
    const requiredReviewer = gate.reviewer === "orchestrator"
      ? teamConfig?.orchestrator
      : gate.reviewer;
    if (requiredReviewer && callerMember !== requiredReviewer && callerMember !== "__leader__") {
      return `Gate blocked: only "${requiredReviewer}" can request revisions for ${targetStatus}. Current caller: "${callerMember}".`;
    }
  }

  return null;
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

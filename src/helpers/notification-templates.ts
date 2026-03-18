/**
 * Structured notification templates for requester lifecycle updates.
 *
 * Each format function produces a human-readable message for `notifyRequester()`.
 * All templates include the Run ID for cross-event correlation.
 */

import type { TeamRun, TeamTask, TeamConfig } from "../types.js";

// ── Shared helpers ────────────────────────────────────────────────────

function fmtDuration(startMs: number, endMs?: number): string {
  const ms = (endMs ?? Date.now()) - startMs;
  const s = Math.floor(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

function statusIcon(status: string): string {
  if (status === "COMPLETED") return "✓";
  if (status === "FAILED") return "✗";
  if (status === "CANCELED") return "–";
  return "…";
}

function taskLine(t: TeamTask): string {
  const icon = statusIcon(t.status);
  const agent = t.assigned_to ?? "unassigned";
  const desc = t.description.slice(0, 50);
  const delivParts: string[] = [];
  if (t.deliverables?.length) {
    for (const d of t.deliverables) {
      delivParts.push(d.type === "file" && d.path ? d.path : d.description ?? d.type);
    }
  }
  const delivSuffix = delivParts.length > 0 ? ` [${delivParts.join(", ")}]` : "";
  const statusSuffix = t.status === "CANCELED" ? " (canceled)" : "";
  return `  ${icon} ${agent}: ${desc}${delivSuffix}${statusSuffix}`;
}

function countsStr(tasks: TeamTask[]): string {
  const c: Record<string, number> = {};
  for (const t of tasks) c[t.status] = (c[t.status] ?? 0) + 1;
  const parts: string[] = [];
  if (c.COMPLETED) parts.push(`${c.COMPLETED} completed`);
  if (c.WORKING) parts.push(`${c.WORKING} working`);
  if (c.PENDING) parts.push(`${c.PENDING} pending`);
  if (c.BLOCKED) parts.push(`${c.BLOCKED} blocked`);
  if (c.FAILED) parts.push(`${c.FAILED} failed`);
  if (c.CANCELED) parts.push(`${c.CANCELED} canceled`);
  return parts.join(", ") || "0 tasks";
}

// ── T1: RUN_STARTED ───────────────────────────────────────────────────

export function fmtRunStarted(run: TeamRun, config: TeamConfig): string {
  const mode = config.coordination === "orchestrator"
    ? `orchestrator: ${config.orchestrator ?? "?"}`
    : "peer";
  const members = Object.keys(config.members).join(", ");
  return (
    `Run started: ${run.id}\n` +
    `Team: ${run.team} (${mode})\n` +
    `Goal: ${run.goal.slice(0, 120)}\n` +
    `Members: ${members}`
  );
}

// ── T2: TASK_ASSIGNED ─────────────────────────────────────────────────

export function fmtTaskAssigned(
  task: TeamTask,
  run: TeamRun,
  routingReason?: string,
): string {
  const routing = routingReason ? ` (${routingReason})` : "";
  const deps = task.depends_on?.length
    ? `\n  Depends on: ${task.depends_on.join(", ")}`
    : "";
  return (
    `Task assigned [${run.id}]\n` +
    `  ${task.id} → ${task.assigned_to ?? "unassigned"}${routing}\n` +
    `  "${task.description.slice(0, 80)}"${deps}\n` +
    `  Run: ${run.tasks.length} tasks (${countsStr(run.tasks)})`
  );
}

// ── T3: TASK_COMPLETED ────────────────────────────────────────────────

export function fmtTaskCompleted(
  task: TeamTask,
  run: TeamRun,
  result?: string,
): string {
  const resultStr = result
    ? `\n  Result: ${result.slice(0, 120)}`
    : "";
  const delivLines: string[] = [];
  if (task.deliverables?.length) {
    for (const d of task.deliverables) {
      const label = d.type === "file" && d.path ? `[file] ${d.path}`
        : d.type === "url" && d.url ? `[url] ${d.url}`
        : `[${d.type}] ${d.description ?? ""}`;
      delivLines.push(`  Deliverable: ${label}`);
    }
  }
  const delivStr = delivLines.length > 0 ? "\n" + delivLines.join("\n") : "";
  return (
    `Task completed [${run.id}]\n` +
    `  ${task.id} by ${task.assigned_to ?? "unassigned"}\n` +
    `  "${task.description.slice(0, 60)}"${resultStr}${delivStr}\n` +
    `  Progress: ${countsStr(run.tasks)}`
  );
}

// ── T4: TASK_FAILED ───────────────────────────────────────────────────

export function fmtTaskFailed(
  task: TeamTask,
  run: TeamRun,
  reason?: string,
): string {
  const reasonStr = reason
    ? `\n  Reason: ${reason.slice(0, 120)}`
    : "";
  return (
    `Task failed [${run.id}]\n` +
    `  ${task.id} by ${task.assigned_to ?? "unassigned"}\n` +
    `  "${task.description.slice(0, 60)}"${reasonStr}\n` +
    `  Progress: ${countsStr(run.tasks)}`
  );
}

// ── T5: TASK_REVISION_REQUESTED ───────────────────────────────────────

export function fmtRevisionRequested(
  task: TeamTask,
  runId: string,
  reviewerMember: string,
  feedback: string,
  revisionCount: number,
): string {
  return (
    `Revision requested [${runId}]\n` +
    `  ${task.id} (assigned: ${task.assigned_to ?? "?"}, reviewer: ${reviewerMember})\n` +
    `  Feedback: ${feedback.slice(0, 150)}\n` +
    `  Revision cycle: #${revisionCount}`
  );
}

// ── T6: RUN_COMPLETED ─────────────────────────────────────────────────

export function fmtRunCompleted(run: TeamRun, result: string): string {
  const duration = fmtDuration(run.started_at, run.completed_at);
  const MAX_TASKS = 10;
  const taskLines = run.tasks.slice(0, MAX_TASKS).map(taskLine);
  if (run.tasks.length > MAX_TASKS) {
    taskLines.push(`  ... and ${run.tasks.length - MAX_TASKS} more tasks`);
  }
  const taskSection = run.tasks.length > 0
    ? `\nTasks:\n${taskLines.join("\n")}`
    : "\nTasks: (none)";

  const delivCount = run.tasks.reduce(
    (sum, t) => sum + (t.deliverables?.length ?? 0), 0,
  );
  const learnCount = run.tasks.filter((t) => t.learning).length;

  const summaryParts: string[] = [countsStr(run.tasks)];
  if (delivCount > 0) summaryParts.push(`${delivCount} deliverables`);
  if (learnCount > 0) summaryParts.push(`${learnCount} learnings`);

  return (
    `Run completed: ${run.id}\n` +
    `Team: ${run.team} | Duration: ${duration}\n` +
    `Result: ${result.slice(0, 150)}` +
    taskSection + "\n" +
    `Summary: ${summaryParts.join(" | ")}`
  );
}

// ── T7: RUN_CANCELED ──────────────────────────────────────────────────

export function fmtRunCanceled(run: TeamRun, reason: string): string {
  const duration = fmtDuration(run.started_at);
  const taskLines = run.tasks.map((t) => {
    const icon = statusIcon(t.status);
    const agent = t.assigned_to ?? "unassigned";
    const desc = t.description.slice(0, 50);
    const state = t.status === "COMPLETED" ? "(completed)"
      : t.status === "CANCELED" ? "(canceled)"
      : `(was ${t.status})`;
    return `  ${icon} ${agent}: ${desc} ${state}`;
  });
  const taskSection = taskLines.length > 0
    ? `\nProgress at cancellation:\n${taskLines.join("\n")}`
    : "";

  const completed = run.tasks.filter((t) => t.status === "COMPLETED").length;
  return (
    `Run canceled: ${run.id}\n` +
    `Team: ${run.team} | Duration: ${duration}\n` +
    `Reason: ${reason.slice(0, 100)}` +
    taskSection + "\n" +
    `Summary: ${completed}/${run.tasks.length} completed`
  );
}

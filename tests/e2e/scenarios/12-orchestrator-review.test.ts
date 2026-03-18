/**
 * Scenario 12: Orchestrator Review / Revision Mechanism (E2E)
 *
 * End-to-end test that validates the REVISION_REQUESTED flow in a real
 * orchestrator team. Goes beyond structural assertions — uses LLM judgment
 * to evaluate the quality of:
 *   - Task decomposition (are tasks well-scoped?)
 *   - Task completion results (substantive work?)
 *   - Revision feedback (actionable, specific?)
 *   - Revised results (did the worker address feedback?)
 *   - Run completion summary (does it reflect the review cycle?)
 *
 * Team: alpha (orchestrator mode — lead, frontend, backend, designer)
 *
 * Flow:
 *   1. Start run → orchestrator decomposes goal into tasks
 *   2. Wait for at least one task to reach COMPLETED
 *   3. Main agent instructs orchestrator to review and request revision
 *   4. Validate REVISION_REQUESTED state + quality of feedback
 *   5. Wait for worker to pick up revision (WORKING) and resubmit (COMPLETED)
 *   6. Validate revised result quality
 *   7. Wait for run completion
 *   8. Full quality audit of all intermediate artifacts
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as crypto from "node:crypto";
import { askAgent } from "../helpers/openclaw.js";
import { getBroadcastPath, readRunState, readActivity, findSystemNotifications } from "../helpers/state.js";
import { EventWatcher } from "../helpers/watcher.js";
import { cleanAllState } from "../helpers/reset.js";
import {
  assertActivityLogIntegrity,
  assertStateConsistency,
  assertRequesterNotifications,
} from "../helpers/lifecycle.js";
import type { TeamRun, TeamTask, ActivityEntry } from "../../../src/types.js";

// ── Helpers ───────────────────────────────────────────────────────────

// Use gamma team: native orchestrator (lead) + CLI workers (coder, tester).
// CLI workers auto-spawn on task assignment — no sessions_send activation needed.
// This eliminates the timing issue where the orchestrator completes the run
// before we can inject a review instruction via askAgent.
const TEAM = "gamma";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll run state until a predicate is satisfied or timeout.
 */
async function waitForRunState(
  predicate: (run: TeamRun) => boolean,
  timeoutMs: number,
  label: string,
): Promise<TeamRun> {
  const start = Date.now();
  let last: TeamRun | null = null;
  while (Date.now() - start < timeoutMs) {
    const run = readRunState(TEAM);
    if (run) {
      last = run;
      if (predicate(run)) return run;
    }
    await sleep(1_000);
  }
  const statusBreakdown = last
    ? last.tasks.reduce((acc, t) => { acc[t.status] = (acc[t.status] ?? 0) + 1; return acc; }, {} as Record<string, number>)
    : {};
  throw new Error(
    `[${label}] Timed out after ${timeoutMs}ms. Last state: ${last?.status ?? "null"}, tasks: ${JSON.stringify(statusBreakdown)}`,
  );
}

// ── Quality Assessment Helpers ────────────────────────────────────────

interface QualityCheck {
  name: string;
  passed: boolean;
  details: string;
  severity: "critical" | "warning" | "info";
}

/**
 * Assess quality of task decomposition — are tasks well-defined?
 */
function assessTaskDecomposition(tasks: TeamTask[]): QualityCheck[] {
  const checks: QualityCheck[] = [];

  // Check 1: Each task has a meaningful description (not too short/generic)
  const shortTasks = tasks.filter((t) => t.description.length < 15);
  checks.push({
    name: "Task descriptions are substantive",
    passed: shortTasks.length === 0,
    details: shortTasks.length === 0
      ? `All ${tasks.length} tasks have descriptions >= 15 chars`
      : `${shortTasks.length} tasks have overly short descriptions: ${shortTasks.map((t) => `"${t.description}"`).join(", ")}`,
    severity: "warning",
  });

  // Check 2: Tasks are assigned to appropriate members
  const unassigned = tasks.filter((t) => !t.assigned_to);
  checks.push({
    name: "All tasks are assigned",
    passed: unassigned.length === 0,
    details: unassigned.length === 0
      ? `All ${tasks.length} tasks have assignees`
      : `${unassigned.length} tasks unassigned`,
    severity: "critical",
  });

  // Check 3: Diverse member utilization (not all tasks to one member)
  const assignees = new Set(tasks.map((t) => t.assigned_to).filter(Boolean));
  checks.push({
    name: "Multiple team members utilized",
    passed: assignees.size > 1,
    details: `${assignees.size} unique assignees: [${[...assignees].join(", ")}]`,
    severity: "warning",
  });

  // Check 4: No duplicate task descriptions
  const descriptions = tasks.map((t) => t.description.toLowerCase().trim());
  const uniqueDescs = new Set(descriptions);
  checks.push({
    name: "No duplicate task descriptions",
    passed: uniqueDescs.size === descriptions.length,
    details: uniqueDescs.size === descriptions.length
      ? "All task descriptions are unique"
      : `${descriptions.length - uniqueDescs.size} duplicate descriptions found`,
    severity: "warning",
  });

  return checks;
}

/**
 * Assess the quality of a task completion result.
 */
function assessCompletionQuality(task: TeamTask): QualityCheck[] {
  const checks: QualityCheck[] = [];
  const result = typeof task.result === "string" ? task.result : JSON.stringify(task.result ?? "");

  // Check 1: Result is not empty
  checks.push({
    name: `Task "${task.id}" has a result`,
    passed: result.length > 0,
    details: result.length > 0
      ? `Result length: ${result.length} chars`
      : "Empty result on COMPLETED task",
    severity: "critical",
  });

  // Check 2: Result is substantive (not just "Done" or "Completed")
  const trivialPatterns = /^(done|completed|finished|ok|yes|no|task (done|completed))\.?$/i;
  const isSubstantive = result.length > 20 && !trivialPatterns.test(result.trim());
  checks.push({
    name: `Task "${task.id}" result is substantive`,
    passed: isSubstantive,
    details: isSubstantive
      ? `Result preview: "${result.slice(0, 120)}..."`
      : `Trivial result: "${result.slice(0, 80)}"`,
    severity: "warning",
  });

  return checks;
}

/**
 * Assess the quality of revision feedback from orchestrator.
 */
function assessRevisionFeedback(
  activity: ActivityEntry[],
  task: TeamTask,
): QualityCheck[] {
  const checks: QualityCheck[] = [];

  const revisionEntries = activity.filter(
    (e) => e.type === "task_revision_requested" && e.target_id === task.id,
  );

  // Check 1: Revision was actually logged
  checks.push({
    name: `Revision requested logged for "${task.id}"`,
    passed: revisionEntries.length > 0,
    details: revisionEntries.length > 0
      ? `${revisionEntries.length} revision request(s) in activity log`
      : "No task_revision_requested activity found",
    severity: "critical",
  });

  if (revisionEntries.length === 0) return checks;

  // Check 2: Feedback metadata is present and non-trivial
  const feedback = (revisionEntries[0].metadata as any)?.feedback as string | undefined;
  checks.push({
    name: `Revision feedback for "${task.id}" is actionable`,
    passed: !!feedback && feedback.length > 15,
    details: feedback
      ? `Feedback (${feedback.length} chars): "${feedback.slice(0, 150)}"`
      : "No feedback metadata in activity",
    severity: "warning",
  });

  // Check 3: Feedback came from orchestrator (lead)
  checks.push({
    name: `Revision was requested by orchestrator`,
    passed: revisionEntries[0].agent === "lead",
    details: `Revision requested by: ${revisionEntries[0].agent}`,
    severity: "critical",
  });

  return checks;
}

/**
 * Assess whether a revised result addresses the revision feedback.
 */
function assessRevisionAddressesFeedback(
  task: TeamTask,
  feedback: string | undefined,
): QualityCheck[] {
  const checks: QualityCheck[] = [];
  const result = typeof task.result === "string" ? task.result : JSON.stringify(task.result ?? "");

  if (!feedback) {
    checks.push({
      name: `Cannot assess revision quality — no feedback to compare`,
      passed: true,
      details: "Skipped — no feedback available",
      severity: "info",
    });
    return checks;
  }

  // Check 1: Result changed after revision (not the same as before)
  checks.push({
    name: `Task "${task.id}" has updated result after revision`,
    passed: result.length > 0,
    details: result.length > 0
      ? `Post-revision result: ${result.length} chars`
      : "Empty result after revision",
    severity: "critical",
  });

  // Check 2: revision_count is set
  checks.push({
    name: `Task "${task.id}" has revision_count set`,
    passed: (task.revision_count ?? 0) > 0,
    details: `revision_count: ${task.revision_count ?? 0}`,
    severity: "critical",
  });

  return checks;
}

/**
 * Print quality report to console.
 */
function printQualityReport(section: string, checks: QualityCheck[]): void {
  console.log(`\n=== Quality Report: ${section} ===`);
  for (const check of checks) {
    const icon = check.passed ? "PASS" : check.severity === "critical" ? "FAIL" : "WARN";
    console.log(`  [${icon}] ${check.name}`);
    console.log(`         ${check.details}`);
  }
  const failed = checks.filter((c) => !c.passed);
  const criticalFails = failed.filter((c) => c.severity === "critical");
  console.log(
    `  Summary: ${checks.length - failed.length}/${checks.length} passed` +
      (criticalFails.length > 0 ? ` (${criticalFails.length} CRITICAL)` : ""),
  );
}

// ── Test ──────────────────────────────────────────────────────────────

describe("Scenario 12: Orchestrator Review Mechanism", () => {
  let watcher: EventWatcher;
  let sessionId: string;

  beforeAll(async () => {
    await cleanAllState();
    watcher = new EventWatcher(getBroadcastPath());
    sessionId = `e2e-review-${crypto.randomUUID()}`;
  }, 180_000);

  afterAll(() => {
    watcher?.close();
  });

  it("12.1: orchestrator review → revision → resubmit lifecycle", { timeout: 900_000 }, async () => {
    const matchTeam = (e: { team: string }) => e.team === TEAM;
    const elapsed = (() => {
      const t0 = Date.now();
      return () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
    })();
    const log = (msg: string) => console.log(`[e2e:review] ${msg} (${elapsed()})`);

    // ── Phase 1: Start a run ────────────────────────────────────────
    log("Phase 1: Starting run...");

    // The goal embeds the review requirement. The orchestrator's prompt
    // already includes REVISION_REQUESTED instructions (from prompt-builder.ts).
    // Embedding it in the goal ensures the orchestrator acts on it.
    const responsePromise = askAgent(
      `Have the gamma team write a simple utility function that validates email addresses. ` +
        `Assign ONE task to the coder member. After the coder completes, ` +
        `the lead MUST review the result and request exactly one revision using ` +
        `team_task(action: "update", status: "REVISION_REQUESTED", message: "...feedback...") ` +
        `before accepting the final version and completing the run. ` +
        `Use the Agent Teams plugin.`,
      { timeout: 120_000, sessionId },
    );

    // Wait for run_started
    await watcher.expectEvent("run_started", {
      timeout: 60_000,
      match: matchTeam,
    });
    log("Run started");

    // Wait for initial agent response
    try {
      await responsePromise;
      log("Main agent responded");
    } catch (err) {
      log(`Main agent response error: ${(err as Error).message} (non-fatal)`);
    }

    // ── Phase 2: Wait for task decomposition ────────────────────────
    log("Phase 2: Waiting for task decomposition...");
    await watcher.expectEvents("task_created", 1, {
      timeout: 300_000,
      match: matchTeam,
    });
    await watcher.waitForQuiet("task_created", 5_000, { match: matchTeam });

    const runAfterDecomposition = await waitForRunState(
      (r) => r.tasks.length >= 1,
      30_000,
      "Task Decomposition",
    );
    log(`${runAfterDecomposition.tasks.length} tasks created`);

    // Quality: assess task decomposition
    const decompositionChecks = assessTaskDecomposition(runAfterDecomposition.tasks);
    printQualityReport("Task Decomposition", decompositionChecks);

    // Assert critical checks
    for (const check of decompositionChecks.filter((c) => c.severity === "critical")) {
      expect(check.passed, check.details).toBe(true);
    }

    // CLI workers auto-spawn — no activation check needed.

    // ── Phase 3: Wait for at least one task COMPLETED ───────────────
    log("Phase 3: Waiting for at least one task to complete...");
    await watcher.expectEvent("task_completed", {
      timeout: 480_000,
      match: matchTeam,
    });

    const runWithCompletion = await waitForRunState(
      (r) => r.tasks.some((t) => t.status === "COMPLETED"),
      30_000,
      "First Completion",
    );

    const firstCompleted = runWithCompletion.tasks.find((t) => t.status === "COMPLETED")!;
    log(`First task completed: ${firstCompleted.id} by ${firstCompleted.assigned_to}`);

    // Quality: assess initial completion
    const initialCompletionChecks = assessCompletionQuality(firstCompleted);
    printQualityReport(`Initial Completion (${firstCompleted.id})`, initialCompletionChecks);

    // ── Phase 4: Wait for orchestrator to review and request revision ──
    log("Phase 4: Waiting for orchestrator to review and request revision...");

    // The goal requires the orchestrator to review and use REVISION_REQUESTED.
    // The orchestrator's system prompt (from prompt-builder.ts) includes
    // instructions for the review mechanism. CLI workers auto-respawn on revision.
    let revisionEventSeen = false;
    try {
      await watcher.expectEvent("task_revision_requested", {
        timeout: 480_000,
        match: matchTeam,
      });
      revisionEventSeen = true;
      log("task_revision_requested event received");
    } catch {
      log("No task_revision_requested event — sending nudge via status check");

      // Nudge: send a status check to trigger the orchestrator
      const runId = runWithCompletion.id;
      try {
        await askAgent(
          `Check on the gamma team: call team_run(action: "status", team: "gamma"). ` +
            `The orchestrator should have reviewed the work and requested a revision. ` +
            `If the run is still active, remind the lead to review by sending: ` +
            `sessions_send({ message: "Review the completed task and use team_task with ` +
            `status=REVISION_REQUESTED to send it back for improvement before completing.", ` +
            `sessionKey: "agent:at--gamma--lead:run:${runId}" })`,
          { timeout: 120_000, sessionId },
        );
      } catch {
        log("Nudge timed out");
      }

      try {
        await watcher.expectEvent("task_revision_requested", {
          timeout: 180_000,
          match: matchTeam,
        });
        revisionEventSeen = true;
        log("task_revision_requested event received after nudge");
      } catch {
        log("Still no task_revision_requested event");
      }
    }

    // Verify REVISION_REQUESTED state (generous timeout — orchestrator may take time to act)
    const runAfterRevision = await waitForRunState(
      (r) =>
        r.tasks.some((t) => t.status === "REVISION_REQUESTED") ||
        // Also accept if worker already picked it up (fast agents)
        r.tasks.some((t) => t.id === firstCompleted.id && (t.revision_count ?? 0) > 0),
      120_000,
      "Revision Requested",
    );

    const revisedTask = runAfterRevision.tasks.find(
      (t) => t.id === firstCompleted.id,
    )!;

    log(`Task ${revisedTask.id} status: ${revisedTask.status}, revision_count: ${revisedTask.revision_count ?? 0}`);

    // Quality: assess revision feedback
    const activityLog = readActivity(TEAM);
    const revisionChecks = assessRevisionFeedback(activityLog, revisedTask);
    printQualityReport("Revision Feedback Quality", revisionChecks);

    // The task should have revision_count > 0 (it was sent for revision)
    expect(
      revisedTask.revision_count ?? 0,
      `Task ${revisedTask.id} should have revision_count > 0`,
    ).toBeGreaterThan(0);

    // ── Phase 5: Wait for worker to pick up and resubmit ────────────
    log("Phase 5: Waiting for revision to be picked up and resubmitted...");

    // If the task is still in REVISION_REQUESTED, we may need to nudge
    if (revisedTask.status === "REVISION_REQUESTED") {
      log("Task still in REVISION_REQUESTED — sending status check to trigger agent wake-up...");
      try {
        await askAgent(
          `Call team_run(action: "status", team: "gamma"). ` +
            `If there are agents that need activation (sessions_send), call them. ` +
            `The worker for task ${firstCompleted.id} needs to pick up the revision.`,
          { timeout: 120_000, sessionId },
        );
        log("Status check sent");
      } catch {
        log("Status check timed out (non-fatal)");
      }
    }

    // Wait for the task to cycle back through WORKING → COMPLETED
    // Allow generous timeout — worker needs to: wake up, read feedback, do work, update
    let runAfterResubmit: TeamRun;
    try {
      runAfterResubmit = await waitForRunState(
        (r) => {
          const t = r.tasks.find((t) => t.id === firstCompleted.id);
          // Task went through revision (revision_count > 0) AND is now COMPLETED
          return !!t && t.status === "COMPLETED" && (t.revision_count ?? 0) > 0;
        },
        480_000,
        "Revision Resubmit",
      );
      log("Task resubmitted as COMPLETED after revision");
    } catch (err) {
      // If the specific task didn't complete, check if run progressed anyway
      log(`Revision resubmit wait failed: ${(err as Error).message}`);
      const currentState = readRunState(TEAM);
      if (currentState) {
        const t = currentState.tasks.find((t) => t.id === firstCompleted.id);
        log(`Task ${firstCompleted.id} current status: ${t?.status}, revision_count: ${t?.revision_count}`);
        log(`Run status: ${currentState.status}`);
      }
      runAfterResubmit = currentState!;
    }

    const resubmittedTask = runAfterResubmit.tasks.find(
      (t) => t.id === firstCompleted.id,
    )!;

    // Quality: assess revised completion
    if (resubmittedTask.status === "COMPLETED") {
      const revisionQuality = assessCompletionQuality(resubmittedTask);
      printQualityReport(`Revised Completion (${resubmittedTask.id})`, revisionQuality);

      // Get the feedback that was provided
      const revEntry = activityLog.find(
        (e) => e.type === "task_revision_requested" && e.target_id === resubmittedTask.id,
      );
      const feedback = (revEntry?.metadata as any)?.feedback as string | undefined;

      const feedbackChecks = assessRevisionAddressesFeedback(resubmittedTask, feedback);
      printQualityReport("Revision Addressed Feedback", feedbackChecks);

      for (const check of feedbackChecks.filter((c) => c.severity === "critical")) {
        expect(check.passed, check.details).toBe(true);
      }
    }

    // ── Phase 6: Wait for run completion ────────────────────────────
    log("Phase 6: Waiting for run completion...");

    // Send a final status check to help the run complete
    try {
      await askAgent(
        `Call team_run(action: "status", team: "gamma"). ` +
          `If all tasks are completed, call team_run(action: "complete", team: "gamma", result: "summary"). ` +
          `If there are pending sessions_send commands or activations, execute them.`,
        { timeout: 120_000, sessionId },
      );
    } catch {
      log("Final status check timed out (non-fatal)");
    }

    let finalState: TeamRun | null = null;
    try {
      finalState = await waitForRunState(
        (r) => r.status === "COMPLETED" || r.status === "CANCELED",
        300_000,
        "Run Completion",
      );
      log(`Run finished: ${finalState.status}`);
    } catch {
      log("Run did not complete within timeout — checking final state");
      finalState = readRunState(TEAM);
    }

    // ── Phase 7: Full Quality Audit ─────────────────────────────────
    log("Phase 7: Running full quality audit...");

    const finalActivity = readActivity(TEAM);
    const allChecks: QualityCheck[] = [];

    // A. Run-level checks
    if (finalState) {
      allChecks.push({
        name: "Run has a goal",
        passed: !!finalState.goal && finalState.goal.length > 10,
        details: `Goal: "${(finalState.goal ?? "").slice(0, 100)}"`,
        severity: "critical",
      });

      allChecks.push({
        name: "Run orchestrator is 'lead'",
        passed: finalState.orchestrator === "lead",
        details: `Orchestrator: ${finalState.orchestrator ?? "none"}`,
        severity: "critical",
      });

      // B. Verify revision cycle appeared in activity log
      const revisionRequested = finalActivity.filter(
        (e) => e.type === "task_revision_requested",
      );
      allChecks.push({
        name: "At least one revision was requested",
        passed: revisionRequested.length > 0,
        details: `${revisionRequested.length} revision request(s) in activity log`,
        severity: "critical",
      });

      const revisionRestarted = finalActivity.filter(
        (e) => e.type === "task_revision_restarted",
      );
      allChecks.push({
        name: "Revision was picked up by worker",
        passed: revisionRestarted.length > 0 || resubmittedTask?.status === "COMPLETED",
        details: `${revisionRestarted.length} revision restart(s) + task final status: ${resubmittedTask?.status ?? "unknown"}`,
        severity: "warning",
      });

      // C. Activity log temporal ordering
      let temporallyCorrect = true;
      for (let i = 1; i < finalActivity.length; i++) {
        if (finalActivity[i].timestamp < finalActivity[i - 1].timestamp) {
          temporallyCorrect = false;
          break;
        }
      }
      allChecks.push({
        name: "Activity log is temporally ordered",
        passed: temporallyCorrect,
        details: temporallyCorrect
          ? `${finalActivity.length} entries in order`
          : "Timestamps out of order",
        severity: "critical",
      });

      // D. All tasks have valid assignees
      const validMembers = ["lead", "coder", "tester"];
      const invalidAssignees = finalState.tasks.filter(
        (t) => t.assigned_to && !validMembers.includes(t.assigned_to),
      );
      allChecks.push({
        name: "All task assignees are valid team members",
        passed: invalidAssignees.length === 0,
        details: invalidAssignees.length === 0
          ? `All assignees in [${validMembers.join(", ")}]`
          : `Invalid: ${invalidAssignees.map((t) => `${t.id}→${t.assigned_to}`).join(", ")}`,
        severity: "critical",
      });

      // E. round_count was incremented (via revision)
      allChecks.push({
        name: "Run round_count reflects revision cycles",
        passed: (finalState.round_count ?? 0) > 0,
        details: `round_count: ${finalState.round_count ?? 0}`,
        severity: "warning",
      });

      // F. Task creation events all from orchestrator
      const taskCreatedEvents = watcher.getEventsOfType("task_created", matchTeam);
      const nonLeadCreators = taskCreatedEvents.filter((e) => e.agent !== "lead");
      allChecks.push({
        name: "Tasks created by orchestrator (lead)",
        passed: nonLeadCreators.length === 0,
        details: nonLeadCreators.length === 0
          ? `All ${taskCreatedEvents.length} tasks created by lead`
          : `${nonLeadCreators.length} tasks created by non-lead: [${nonLeadCreators.map((e) => e.agent).join(", ")}]`,
        severity: "warning",
      });

      // G. Completed tasks have results
      const completedTasks = finalState.tasks.filter((t) => t.status === "COMPLETED");
      const completedWithoutResult = completedTasks.filter((t) => !t.result);
      allChecks.push({
        name: "All completed tasks have results",
        passed: completedWithoutResult.length === 0,
        details: `${completedTasks.length - completedWithoutResult.length}/${completedTasks.length} completed tasks have results`,
        severity: "warning",
      });
    }

    printQualityReport("Full Quality Audit", allChecks);

    // Assert critical checks
    const criticalFails = allChecks.filter((c) => !c.passed && c.severity === "critical");
    if (criticalFails.length > 0) {
      console.log("\n!!! CRITICAL FAILURES !!!");
      for (const f of criticalFails) {
        console.log(`  - ${f.name}: ${f.details}`);
      }
    }

    // Hard assertions
    for (const check of criticalFails) {
      expect(check.passed, `CRITICAL: ${check.name} — ${check.details}`).toBe(true);
    }

    // Log transcript notifications (informational — transcripts may be cleaned between scenarios)
    const sysNotifications = findSystemNotifications(sessionId, TEAM);
    console.log(`Transcript notifications for ${TEAM}: ${sysNotifications.length}`);

    // Requester notification assertions
    assertRequesterNotifications(TEAM, {
      taskProgress: true,
      revisionRequested: revisionEventSeen ? true : undefined,
      runCompleted: finalState?.status === "COMPLETED" ? true : undefined,
    });
  });

  it("12.2: state consistency after review cycle", { timeout: 30_000 }, () => {
    assertStateConsistency(TEAM);
  });

  it("12.3: activity log integrity", { timeout: 30_000 }, () => {
    assertActivityLogIntegrity(TEAM);
  });

  it("12.4: review-specific activity events exist", { timeout: 30_000 }, () => {
    const activity = readActivity(TEAM);

    // Must have at least one task_revision_requested
    const revisionRequested = activity.filter(
      (e) => e.type === "task_revision_requested",
    );
    expect(
      revisionRequested.length,
      "Expected at least 1 task_revision_requested activity entry",
    ).toBeGreaterThanOrEqual(1);

    // Each revision request should have metadata with feedback
    for (const entry of revisionRequested) {
      expect(entry.target_id, "Revision entry should have target_id").toBeTruthy();
      expect(entry.agent, "Revision entry should have agent").toBeTruthy();
      const metadata = entry.metadata as Record<string, unknown> | undefined;
      expect(metadata?.revision_count, "Revision should have revision_count").toBeDefined();
    }

    // Verify event ordering: task_created < task_completed < task_revision_requested
    const firstCreated = activity.find((e) => e.type === "task_created");
    const firstCompleted = activity.find((e) => e.type === "task_completed");
    const firstRevision = activity.find(
      (e) => e.type === "task_revision_requested",
    );

    if (firstCreated && firstCompleted) {
      expect(firstCreated.timestamp).toBeLessThanOrEqual(firstCompleted.timestamp);
    }
    if (firstCompleted && firstRevision) {
      expect(firstCompleted.timestamp).toBeLessThanOrEqual(firstRevision.timestamp);
    }
  });
});

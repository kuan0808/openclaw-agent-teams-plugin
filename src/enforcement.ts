/**
 * Lazy enforcement of run limits (timeout, max_rounds).
 *
 * Checked on every team tool call rather than via timers/schedulers,
 * since every team interaction passes through one of the 5 tools.
 */

import type { TeamRun, TeamConfig, ActivityType } from "./types.js";
import type { RunManager } from "./state/run-manager.js";
import { TERMINAL_TASK_STATES } from "./state/run-manager.js";
import type { ActivityLog } from "./state/activity-log.js";
import { notifyRequester } from "./helpers/notification-helpers.js";
import { safeSaveAll, buildConsolidatedResult } from "./helpers/result-helpers.js";
import { fmtRunCanceled, fmtRunCompleted } from "./helpers/notification-templates.js";

export type Violation = { type: "timeout" | "max_rounds"; message: string };

/** Map violation types to their corresponding activity log types. */
export const VIOLATION_ACTIVITY_TYPE: Record<Violation["type"], ActivityType> = {
  timeout: "run_timeout",
  max_rounds: "run_max_rounds_exceeded",
};

/**
 * Check whether a run has exceeded its configured limits.
 * Returns a Violation if a limit is breached, null otherwise.
 *
 * Only checks WORKING runs — completed/canceled runs are already terminal.
 */
export function checkRunLimits(run: TeamRun, config: TeamConfig): Violation | null {
  if (run.status !== "WORKING") return null;

  // Timeout check
  const timeout = config.workflow?.timeout;
  if (timeout) {
    const elapsed = (Date.now() - run.started_at) / 1000;
    if (elapsed > timeout) {
      return {
        type: "timeout",
        message: `Run exceeded timeout (${Math.round(elapsed)}s > ${timeout}s)`,
      };
    }
  }

  // Max rounds check
  const maxRounds = config.workflow?.max_rounds;
  if (maxRounds && run.round_count && run.round_count >= maxRounds) {
    return {
      type: "max_rounds",
      message: `Run exceeded max rounds (${run.round_count} >= ${maxRounds})`,
    };
  }

  return null;
}

/**
 * Handle an enforcement violation: cancel the run, log activity, notify requester, save.
 * Returns an error message string suitable for `errorResult()`.
 */
export async function handleEnforcementViolation(
  runs: RunManager,
  activity: ActivityLog,
  team: string,
  member: string,
  run: TeamRun,
  violation: Violation,
): Promise<string> {
  try {
    runs.cancelRun(team, violation.message, run.id);
  } catch { /* already canceled */ }
  activity.log(team, member,
    VIOLATION_ACTIVITY_TYPE[violation.type],
    violation.message, {
      target_id: run.id,
      metadata: { violation_type: violation.type },
    });
  notifyRequester(team, fmtRunCanceled(run, `Auto-canceled: ${violation.message}`), run.id);
  await safeSaveAll([runs.save(), activity.save()]);
  return `Run canceled: ${violation.message}`;
}

// ── Orchestrator idle & auto-complete (lazy enforcement) ───────────────

/** Grace period (ms) before flagging an orchestrator run with zero tasks as idle. */
export const ORCH_IDLE_GRACE_MS = 45_000;

/** Grace period (seconds) before auto-completing an orchestrator run. */
const ORCH_AUTO_COMPLETE_GRACE_SECONDS = 60;

/**
 * Check whether an orchestrator-mode run should be auto-completed.
 * Returns true if all tasks are terminal and the grace period has elapsed.
 */
export function shouldOrchestratorAutoComplete(
  run: TeamRun,
  config: TeamConfig,
): boolean {
  if (run.status !== "WORKING") return false;
  if (config.coordination !== "orchestrator") return false;
  if (!run.all_terminal_at) return false;

  const elapsed = (Date.now() - run.all_terminal_at) / 1000;
  return elapsed >= ORCH_AUTO_COMPLETE_GRACE_SECONDS;
}

/**
 * Handle orchestrator auto-complete: complete the run with a consolidated result.
 * Returns a status message string, or null if the run was not auto-completed.
 */
export async function handleOrchestratorAutoComplete(
  runs: RunManager,
  activity: ActivityLog,
  team: string,
  member: string,
  run: TeamRun,
): Promise<string | null> {
  const consolidated = buildConsolidatedResult(run);
  try {
    runs.completeRun(team, consolidated, run.id);
  } catch {
    return null; // run may already be completed or have new non-terminal tasks
  }
  activity.log(team, member, "run_completed",
    "Auto-completed: orchestrator did not finalize within grace period", {
      target_id: run.id,
      metadata: { auto_complete: true, orchestrator_mode: true, grace_seconds: ORCH_AUTO_COMPLETE_GRACE_SECONDS },
    });
  notifyRequester(team, fmtRunCompleted(run, consolidated), run.id);
  await safeSaveAll([runs.save(), activity.save()]);
  return `Run auto-completed after ${ORCH_AUTO_COMPLETE_GRACE_SECONDS}s grace period.`;
}

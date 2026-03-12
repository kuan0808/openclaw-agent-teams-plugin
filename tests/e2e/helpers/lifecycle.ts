/**
 * Checkpoint-based lifecycle validation for full E2E lifecycle tests.
 *
 * Each checkpoint: wait for broadcast event → read state file → assert → log progress.
 * taskCount discovered at CP2 flows through CP3-CP5 for precise assertions.
 */

import { expect } from "vitest";
import type {
  BroadcastEvent,
  ActivityType,
  CoordinationMode,
  TeamRun,
  TaskState,
} from "../../../src/types.js";
import type { AgentResponse } from "./openclaw.js";
import type { EventWatcher } from "./watcher.js";
import { askAgent } from "./openclaw.js";
import { readRunState, readActivity } from "./state.js";

// ── Checkpoint Types ─────────────────────────────────────────────────

export interface CheckpointConfig {
  team: string;
  validMembers: string[];
  coordinationMode: CoordinationMode;
  orchestrator?: string;       // orchestrator mode only (e.g. "lead")
  maxTasks?: number;           // default 20
  timeouts?: {
    runStarted?: number;       // default 60_000
    taskCreation?: number;     // default 300_000
    taskStabilize?: number;    // default 5_000
    workInProgress?: number;   // default 300_000
    taskCompletion?: number;   // default 300_000
    runCompletion?: number;    // default 600_000
    safetyNet?: number;        // default 180_000
  };
}

export interface CheckpointResult {
  name: string;
  passed: boolean;
  elapsedMs: number;
  details: string;
  softFailures?: string[];
}

export interface LifecycleProgress {
  checkpoints: CheckpointResult[];
  completed: boolean;
  usedSafetyNet: boolean;
  allEvents: BroadcastEvent[];
  finalState: TeamRun | null;
  diagnosticSummary: string;
}

// ── Terminal task states ─────────────────────────────────────────────

const TERMINAL_STATES: Set<TaskState> = new Set([
  "COMPLETED",
  "FAILED",
  "CANCELED",
] as TaskState[]);

function isTerminal(status: TaskState): boolean {
  return TERMINAL_STATES.has(status);
}

function statusBreakdown(tasks: { status: TaskState }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const t of tasks) {
    counts[t.status] = (counts[t.status] ?? 0) + 1;
  }
  return counts;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeRunState(runState: TeamRun | null): string {
  if (!runState) return "no run state file";
  return `status=${runState.status}, tasks=${JSON.stringify(statusBreakdown(runState.tasks))}`;
}

async function waitForRunState(
  team: string,
  timeoutMs: number,
  predicate: (runState: TeamRun) => boolean,
  intervalMs = 1_000,
): Promise<TeamRun> {
  const startedAt = Date.now();
  let lastState: TeamRun | null = null;

  while (Date.now() - startedAt < timeoutMs) {
    const runState = readRunState(team);
    if (runState) {
      lastState = runState;
      if (predicate(runState)) {
        return runState;
      }
    }
    await sleep(intervalMs);
  }

  throw new Error(
    `Timed out waiting for run state condition after ${timeoutMs}ms. Last state: ${describeRunState(lastState)}`,
  );
}

// ── Checkpoint Runner ────────────────────────────────────────────────

/**
 * Run sequential lifecycle checkpoints. CP2 records taskCount which flows into CP3-CP5.
 */
export async function runLifecycleCheckpoints(
  config: CheckpointConfig,
  watcher: EventWatcher,
  agentResponsePromise: Promise<AgentResponse>,
  sessionId: string,
): Promise<LifecycleProgress> {
  const { team, validMembers, coordinationMode, maxTasks = 20 } = config;
  const timeouts = {
    runStarted: config.timeouts?.runStarted ?? 60_000,
    taskCreation: config.timeouts?.taskCreation ?? 300_000,
    taskStabilize: config.timeouts?.taskStabilize ?? 5_000,
    workInProgress: config.timeouts?.workInProgress ?? 300_000,
    taskCompletion: config.timeouts?.taskCompletion ?? 300_000,
    runCompletion: config.timeouts?.runCompletion ?? 600_000,
    safetyNet: config.timeouts?.safetyNet ?? 180_000,
  };

  const t0 = Date.now();
  const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
  const log = (msg: string) => console.log(`[lifecycle:${team}] ${msg} (${elapsed()})`);

  const matchTeam = (e: BroadcastEvent) => e.team === team;
  const checkpoints: CheckpointResult[] = [];
  let taskCount = 0;
  let taskIds: string[] = [];
  let stopped = false;

  // Helper to record a checkpoint result
  function record(name: string, passed: boolean, details: string, cpStart: number, softFailures?: string[]): CheckpointResult {
    const result: CheckpointResult = {
      name,
      passed,
      elapsedMs: Date.now() - cpStart,
      details,
      softFailures,
    };
    checkpoints.push(result);
    const status = passed ? "PASS" : "FAIL";
    log(`${status} ${name} (${(result.elapsedMs / 1000).toFixed(1)}s): ${details}`);
    return result;
  }

  // ── CP1: Run Started ───────────────────────────────────────────────
  const cp1Start = Date.now();
  try {
    await watcher.expectEvent("run_started", {
      timeout: timeouts.runStarted,
      match: matchTeam,
    });

    const runState = await waitForRunState(
      team,
      10_000,
      (state) => state.status === "WORKING" && !!state.goal,
    );
    if (runState.status !== "WORKING") {
      record("Run Started", false, `status=${runState.status}, expected WORKING`, cp1Start);
      stopped = true;
    } else if (!runState.goal) {
      record("Run Started", false, "status=WORKING but goal is empty", cp1Start);
      stopped = true;
    } else if (
      coordinationMode === "orchestrator" &&
      runState.orchestrator !== config.orchestrator
    ) {
      record(
        "Run Started",
        false,
        `orchestrator=${runState.orchestrator ?? "null"}, expected ${config.orchestrator}`,
        cp1Start,
      );
      stopped = true;
    } else if (coordinationMode === "peer" && runState.orchestrator) {
      record(
        "Run Started",
        false,
        `peer run should not declare an orchestrator, got ${runState.orchestrator}`,
        cp1Start,
      );
      stopped = true;
    } else {
      record(
        "Run Started",
        true,
        `status=WORKING, goal="${runState.goal.slice(0, 60)}...", orchestrator=${runState.orchestrator ?? "none"}`,
        cp1Start,
      );
    }
  } catch (err) {
    record("Run Started", false, `Timed out: ${(err as Error).message}`, cp1Start);
    stopped = true;
  }

  // ── Await agent response ───────────────────────────────────────────
  if (!stopped) {
    try {
      const response = await agentResponsePromise;
      assertValidResponse(response);
      log("Agent response valid");
    } catch (err) {
      log(`Agent response error: ${(err as Error).message}`);
      // Non-fatal — subagents may still be working
    }
  }

  // ── CP2: Task Decomposition ────────────────────────────────────────
  if (!stopped) {
    const cp2Start = Date.now();
    try {
      // Wait for at least 2 task_created events
      await watcher.expectEvents("task_created", 2, {
        timeout: timeouts.taskCreation,
        match: matchTeam,
      });

      // Stabilize: wait for quiet period (no more task_created)
      log("Waiting for task creation to stabilize...");
      await watcher.waitForQuiet("task_created", timeouts.taskStabilize, {
        match: matchTeam,
      });

      // Read state and validate
      const runState = await waitForRunState(team, 10_000, (state) => state.tasks.length >= 2);
      taskCount = runState.tasks.length;
      taskIds = runState.tasks.map((task) => task.id);

      if (taskCount < 2) {
        record("Task Decomposition", false, `Only ${taskCount} tasks in state (need >= 2)`, cp2Start);
        stopped = true;
      } else if (taskCount > maxTasks) {
        const firstFive = runState.tasks.slice(0, 5).map((t) => t.description.slice(0, 50));
        record(
          "Task Decomposition",
          false,
          `Task explosion: ${taskCount} tasks created (max: ${maxTasks}). First 5: ${JSON.stringify(firstFive)}`,
          cp2Start,
        );
        stopped = true;
      } else if (runState.tasks.some((task) => !task.description?.trim())) {
        record("Task Decomposition", false, "One or more tasks are missing descriptions", cp2Start);
        stopped = true;
      } else {
        const assignees = runState.tasks.map((t) => t.assigned_to).filter(Boolean) as string[];
        const uniqueAssignees = [...new Set(assignees)];
        const invalidAssignees = uniqueAssignees.filter((assignee) => !validMembers.includes(assignee));
        if (invalidAssignees.length > 0) {
          record(
            "Task Decomposition",
            false,
            `Unknown assignees: [${invalidAssignees.join(", ")}]`,
            cp2Start,
          );
          stopped = true;
        } else {
          const taskCreatedEvents = watcher.getEventsOfType("task_created", matchTeam);
          if (coordinationMode === "orchestrator" && config.orchestrator) {
            const nonOrchestrator = taskCreatedEvents.filter((e) => e.agent !== config.orchestrator);
            if (nonOrchestrator.length > 0) {
              record(
                "Task Decomposition",
                false,
                `${nonOrchestrator.length} task_created events came from non-orchestrator agents: [${nonOrchestrator.map((e) => e.agent).join(", ")}]`,
                cp2Start,
              );
              stopped = true;
            } else {
              record(
                "Task Decomposition",
                true,
                `${taskCount} tasks, assignees: [${uniqueAssignees.join(", ")}], created by ${config.orchestrator}`,
                cp2Start,
              );
            }
          } else {
            const invalidCreators = taskCreatedEvents.filter((e) => !validMembers.includes(e.agent));
            if (invalidCreators.length > 0) {
              record(
                "Task Decomposition",
                false,
                `${invalidCreators.length} task_created events came from invalid agents: [${invalidCreators.map((e) => e.agent).join(", ")}]`,
                cp2Start,
              );
              stopped = true;
            } else {
              record(
                "Task Decomposition",
                true,
                `${taskCount} tasks, assignees: [${uniqueAssignees.join(", ")}], creators: [${[...new Set(taskCreatedEvents.map((e) => e.agent))].join(", ")}]`,
                cp2Start,
              );
            }
          }
        }
      }
    } catch (err) {
      record("Task Decomposition", false, `Timed out: ${(err as Error).message}`, cp2Start);
      stopped = true;
    }
  }

  // ── CP3: Work In Progress ──────────────────────────────────────────
  // Agents may skip WORKING and go PENDING → COMPLETED directly.
  // Accept both task_updated(to_status=WORKING) and task_completed/task_failed
  // as evidence that a task has progressed past PENDING.
  if (!stopped) {
    const cp3Start = Date.now();
    log(`Waiting for ${taskCount} created tasks to leave PENDING...`);
    try {
      const runState = await waitForRunState(
        team,
        timeouts.workInProgress,
        (state) =>
          taskIds.every((taskId) => {
            const task = state.tasks.find((candidate) => candidate.id === taskId);
            return !!task && task.status !== "PENDING";
          }),
      );

      const softFailures: string[] = [];
      const workingEvents = watcher.getEventsOfType(
        "task_updated",
        (e) => e.team === team && e.data?.to_status === "WORKING",
      );
      const createdTasks = runState.tasks.filter((task) => taskIds.includes(task.id));
      const terminalOrInput = createdTasks.filter((task) =>
        task.status === "COMPLETED" ||
        task.status === "FAILED" ||
        task.status === "CANCELED" ||
        task.status === "INPUT_REQUIRED",
      ).length;
      const blocked = createdTasks.filter((task) => task.status === "BLOCKED").length;

      if (workingEvents.length < createdTasks.length) {
        softFailures.push(
          `${createdTasks.length - workingEvents.length}/${createdTasks.length} tasks did not emit a WORKING transition event`,
        );
      }
      if (blocked > 0) {
        softFailures.push(`${blocked}/${createdTasks.length} tasks are still BLOCKED after work started`);
      }

      record(
        "Work In Progress",
        true,
        `${createdTasks.length}/${createdTasks.length} created tasks moved beyond PENDING (${terminalOrInput} already beyond active work)`,
        cp3Start,
        softFailures.length > 0 ? softFailures : undefined,
      );
    } catch (err) {
      const runState = readRunState(team);
      const breakdown = runState ? statusBreakdown(runState.tasks) : {};
      record(
        "Work In Progress",
        false,
        `Some created tasks remained PENDING. State: ${JSON.stringify(breakdown)}. ${(err as Error).message}`,
        cp3Start,
      );
      stopped = true;
    }
  }

  // ── CP4: Task Completion ───────────────────────────────────────────
  if (!stopped) {
    const cp4Start = Date.now();
    log("Waiting for all tasks to reach terminal state...");
    try {
      const runState = await waitForRunState(
        team,
        timeouts.taskCompletion,
        (state) => state.tasks.length > 0 && state.tasks.every((task) => isTerminal(task.status)),
      );

      const completed = runState.tasks.filter((t) => t.status === "COMPLETED").length;
      const failed = runState.tasks.filter((t) => t.status === "FAILED").length;
      const canceled = runState.tasks.filter((t) => t.status === "CANCELED").length;

      record(
        "Task Completion",
        true,
        `${runState.tasks.length}/${runState.tasks.length} tasks terminal (${completed} completed, ${failed} failed, ${canceled} canceled)`,
        cp4Start,
      );
    } catch (err) {
      const runState = readRunState(team);
      const breakdown = runState ? statusBreakdown(runState.tasks) : {};
      record(
        "Task Completion",
        false,
        `Not all tasks reached terminal state. Status: ${JSON.stringify(breakdown)}. ${(err as Error).message}`,
        cp4Start,
      );
      stopped = true;
    }
  }

  // ── CP5: Run Completion ────────────────────────────────────────────
  let usedSafetyNet = false;
  let finalState: TeamRun | null = null;
  {
    const cp5Start = Date.now();
    log(`Waiting for run completion state (timeout: ${(timeouts.runCompletion / 1000).toFixed(0)}s)...`);

    let completedByState = false;

    // Safety net nudge
    if (!stopped) {
      try {
        finalState = await waitForRunState(
          team,
          timeouts.runCompletion,
          (state) => state.status === "COMPLETED" && state.tasks.every((task) => isTerminal(task.status)),
        );
        completedByState = true;
      } catch {
        log(`Run did not reach COMPLETED within ${(timeouts.runCompletion / 1000).toFixed(0)}s — trying safety net`);
      }
    }

    if (!completedByState) {
      usedSafetyNet = true;
      log("Sending safety-net nudge...");
      try {
        await askAgent(
          `Check the status of the ${team} team run and complete it if all tasks are done. ` +
            `Use team_run(action: status) to check, then team_run(action: complete) if ready.`,
          { timeout: 120_000, sessionId },
        );
        log("Safety-net nudge sent");
      } catch {
        log("Safety-net nudge failed");
      }

      try {
        finalState = await waitForRunState(
          team,
          timeouts.safetyNet,
          (state) => state.status === "COMPLETED" && state.tasks.every((task) => isTerminal(task.status)),
        );
        completedByState = true;
        log("Run reached COMPLETED after safety net");
      } catch {
        log("Run did not complete even after safety net");
      }
    }

    // Final state validation
    finalState ??= readRunState(team);
    const softFailures: string[] = [];
    const activity = readActivity(team);
    const runCompletedEntries = activity.filter((entry) => entry.type === "run_completed");
    const runCompletedEntry = runCompletedEntries.at(-1);

    if (completedByState && finalState) {
      if (finalState.status !== "COMPLETED") {
        softFailures.push(`Run status=${finalState.status}, expected COMPLETED`);
      }

      const terminalTasks = finalState.tasks.filter((t) => isTerminal(t.status));
      if (terminalTasks.length !== finalState.tasks.length) {
        softFailures.push(`${terminalTasks.length}/${finalState.tasks.length} tasks terminal in state`);
      }

      // Activity audit trail
      if (activity.length === 0) {
        softFailures.push("Activity log is empty");
      } else {
        const types = new Set(activity.map((e) => e.type));
        if (!types.has("run_started")) softFailures.push("Missing run_started in activity");
        if (!types.has("task_created")) softFailures.push("Missing task_created in activity");
        if (!types.has("run_completed")) softFailures.push("Missing run_completed in activity");
      }

      // Mode-specific
      if (runCompletedEntry) {
        if (coordinationMode === "orchestrator" && config.orchestrator) {
          if (runCompletedEntry.agent !== config.orchestrator) {
            record(
              "Run Completion",
              false,
              `run_completed agent=${runCompletedEntry.agent}, expected ${config.orchestrator}`,
              cp5Start,
              softFailures.length > 0 ? softFailures : undefined,
            );
            completedByState = false;
          }
        } else if (coordinationMode === "peer") {
          if (!validMembers.includes(runCompletedEntry.agent)) {
            record(
              "Run Completion",
              false,
              `run_completed agent=${runCompletedEntry.agent} not in valid members`,
              cp5Start,
              softFailures.length > 0 ? softFailures : undefined,
            );
            completedByState = false;
          }
        }
      }

      if (completedByState) {
        record(
          "Run Completion",
          true,
          `status=${finalState.status}, all ${finalState.tasks.length} tasks done`,
          cp5Start,
          softFailures.length > 0 ? softFailures : undefined,
        );
      }
    } else {
      // Partial progress info
      let details = "Run did not complete";
      if (finalState) {
        const breakdown = statusBreakdown(finalState.tasks);
        details += `. status=${finalState.status}, tasks=${JSON.stringify(breakdown)}`;
      }
      record("Run Completion", false, details, cp5Start, softFailures.length > 0 ? softFailures : undefined);
    }
  }

  const progress: LifecycleProgress = {
    checkpoints,
    completed: checkpoints.find((c) => c.name === "Run Completion")?.passed ?? false,
    usedSafetyNet,
    allEvents: watcher.getEvents(),
    finalState,
    diagnosticSummary: "",
  };

  progress.diagnosticSummary = buildDiagnosticSummary(config, progress);
  return progress;
}

// ── Diagnostic Summary ───────────────────────────────────────────────

function buildDiagnosticSummary(
  config: CheckpointConfig,
  progress: LifecycleProgress,
): string {
  const { team, coordinationMode } = config;
  const taskCount = progress.finalState?.tasks.length ?? 0;

  const lines: string[] = [];
  lines.push(
    `=== Lifecycle Diagnostic: team="${team}" mode=${coordinationMode}, taskCount=${taskCount} ===`,
  );

  for (const cp of progress.checkpoints) {
    const status = cp.passed ? "PASS" : "FAIL";
    lines.push(`  [${status}] ${cp.name} (${(cp.elapsedMs / 1000).toFixed(1)}s): ${cp.details}`);
    if (cp.softFailures) {
      for (const sf of cp.softFailures) {
        lines.push(`    [SOFT] ${sf}`);
      }
    }
  }

  // State summary
  if (progress.finalState) {
    const breakdown = statusBreakdown(progress.finalState.tasks);
    lines.push(`  State: run=${progress.finalState.status}, tasks=${JSON.stringify(breakdown)}`);
  } else {
    lines.push("  State: no run state file");
  }

  // Event summary
  const teamEvents = progress.allEvents.filter((e) => e.team === team);
  const eventCounts: Record<string, number> = {};
  for (const e of teamEvents) {
    eventCounts[e.type] = (eventCounts[e.type] ?? 0) + 1;
  }
  lines.push(`  Events: ${JSON.stringify(eventCounts)}`);

  if (progress.usedSafetyNet) {
    lines.push("  Safety net: used");
  }

  return lines.join("\n");
}

// ── Legacy: assertEventSequence ──────────────────────────────────────

/**
 * Validate event ordering for a team's lifecycle.
 */
export function assertEventSequence(
  events: BroadcastEvent[],
  team: string,
  opts?: { minTasks?: number; expectRunCompleted?: boolean },
): {
  runStarted: number;
  taskCreated: number;
  taskUpdated: number;
  taskCompleted: number;
  taskFailed: number;
  runCompleted: number;
  runCanceled: number;
} {
  const minTasks = opts?.minTasks ?? 2;
  const expectRunCompleted = opts?.expectRunCompleted ?? false;

  const teamEvents = events.filter((e) => e.team === team);
  const byType = (type: ActivityType) => teamEvents.filter((e) => e.type === type);

  const counts = {
    runStarted: byType("run_started").length,
    taskCreated: byType("task_created").length,
    taskUpdated: byType("task_updated").length,
    taskCompleted: byType("task_completed").length,
    taskFailed: byType("task_failed").length,
    runCompleted: byType("run_completed").length,
    runCanceled: byType("run_canceled").length,
  };

  if (counts.runStarted !== 1) {
    throw new Error(`Expected exactly 1 run_started, got ${counts.runStarted}`);
  }

  if (counts.taskCreated < minTasks) {
    throw new Error(`Expected at least ${minTasks} task_created, got ${counts.taskCreated}`);
  }

  const runStartedTs = byType("run_started")[0].ts;
  const firstTaskCreated = byType("task_created")[0];
  if (firstTaskCreated && firstTaskCreated.ts < runStartedTs) {
    throw new Error("task_created event occurred before run_started");
  }

  if (expectRunCompleted) {
    if (counts.runCompleted !== 1) {
      throw new Error(`Expected exactly 1 run_completed, got ${counts.runCompleted}`);
    }
    const lastCreatedTs = Math.max(...byType("task_created").map((e) => e.ts));
    const runCompletedTs = byType("run_completed")[0].ts;
    if (runCompletedTs < lastCreatedTs) {
      throw new Error("run_completed occurred before last task_created");
    }
  }

  return counts;
}

// ── Shared assertion helpers ─────────────────────────────────────────────

/** Assert that an agent response is valid (non-error, has payloads). */
export function assertValidResponse(response: AgentResponse): void {
  expect(response.payloads).toBeDefined();
  expect(response.payloads!.length).toBeGreaterThan(0);
  expect(response.meta.error).toBeUndefined();
}

/** Assert activity log integrity for a team. */
export function assertActivityLogIntegrity(team: string): void {
  const activity = readActivity(team);
  const activityTypes = activity.map((e) => e.type);
  expect(activityTypes).toContain("run_started");
  expect(activityTypes).toContain("task_created");

  // Temporal ordering
  for (let i = 1; i < activity.length; i++) {
    expect(activity[i].timestamp).toBeGreaterThanOrEqual(
      activity[i - 1].timestamp,
    );
  }

  // Every entry has team/agent/timestamp
  for (const entry of activity) {
    expect(entry.team).toBe(team);
    expect(entry.agent).toBeTruthy();
    expect(entry.timestamp).toBeGreaterThan(0);
  }
}

/** Assert state consistency: activity log matches run state. */
export function assertStateConsistency(team: string): void {
  const runState = readRunState(team);
  const activity = readActivity(team);

  if (!runState) {
    expect.soft(runState).not.toBeNull();
    return;
  }

  // Every task_completed in activity should have a corresponding task in state
  const completedActivity = activity.filter((e) => e.type === "task_completed");
  for (const entry of completedActivity) {
    if (entry.target_id) {
      const matchingTask = runState.tasks.find((t) => t.id === entry.target_id);
      expect.soft(matchingTask).toBeDefined();
      if (matchingTask) {
        expect.soft(matchingTask.status).toBe("COMPLETED");
      }
    }
  }

  // Run state task count should be consistent with activity
  const taskCreatedCount = activity.filter((e) => e.type === "task_created").length;
  expect.soft(runState.tasks.length).toBe(taskCreatedCount);
}

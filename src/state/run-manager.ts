/**
 * TeamRun state machine — concurrent runs support.
 *
 * Manages the lifecycle of team runs and their tasks. Each run is
 * persisted as a separate file under `active/<runId>.json` while active,
 * then moved to `archive/<runId>.json` on completion/cancellation.
 *
 * Supports multiple concurrent active runs for per-run session architecture.
 *
 * Methods accept a `team` parameter for interface compatibility
 * (each team has its own RunManager instance, so it's ignored internally).
 */

import type { TeamRun, TeamTask, TaskState, DeliverableEntry, StructuredLearning } from "../types.js";
import { readJson, writeJson, ensureDir, listJsonFiles } from "./persistence.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

// ── Task state machine valid transitions ─────────────────────────────

const VALID_TRANSITIONS: Record<TaskState, TaskState[]> = {
  BLOCKED:        ["PENDING", "CANCELED"],
  PENDING:        ["WORKING", "BLOCKED", "CANCELED"],
  WORKING:        ["COMPLETED", "FAILED", "INPUT_REQUIRED", "CANCELED"],
  INPUT_REQUIRED: ["WORKING", "FAILED", "CANCELED"],
  COMPLETED:      [],
  FAILED:         ["PENDING"],
  CANCELED:       [],
};

export const TERMINAL_TASK_STATES = new Set<TaskState>([
  "COMPLETED",
  "FAILED",
  "CANCELED",
]);

export function validateTransition(from: TaskState, to: TaskState): string | null {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    return `Invalid task state transition: ${from} → ${to}. Allowed from ${from}: ${allowed?.join(", ") || "(terminal state)"}`;
  }
  return null;
}

export class RunManager {
  private activeRuns: Map<string, TeamRun> = new Map();
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  // ── Disk I/O ────────────────────────────────────────────────────────

  async load(): Promise<void> {
    await ensureDir(this.baseDir);

    // Load from new per-run active directory
    const activeDir = path.join(this.baseDir, "active");
    await ensureDir(activeDir);
    const activeFiles = await listJsonFiles(activeDir);

    const runs = await Promise.all(
      activeFiles.map((file) => readJson<TeamRun | null>(path.join(activeDir, file), null)),
    );
    for (const run of runs) {
      if (run) {
        this.activeRuns.set(run.id, run);
      }
    }

    // Migration: load legacy current.json if present and no active runs loaded
    if (this.activeRuns.size === 0) {
      const legacyRun = await readJson<TeamRun | null>(
        path.join(this.baseDir, "current.json"),
        null,
      );
      if (legacyRun) {
        this.activeRuns.set(legacyRun.id, legacyRun);
      }
    }
  }

  async save(): Promise<void> {
    const activeDir = path.join(this.baseDir, "active");
    await ensureDir(activeDir);

    // Write each active run to its own file in parallel
    await Promise.all(
      [...this.activeRuns.entries()].map(([runId, run]) =>
        writeJson(path.join(activeDir, `${runId}.json`), run),
      ),
    );
  }

  // ── Run lifecycle ───────────────────────────────────────────────────

  startRun(
    team: string,
    goal: string,
    orchestrator?: string,
    requesterSession?: string,
  ): { run_id: string; status: string; orchestrator?: string } {
    const now = Date.now();
    const run: TeamRun = {
      id: this.generateRunId(),
      team,
      goal,
      status: "WORKING",
      ...(orchestrator != null ? { orchestrator } : {}),
      ...(requesterSession != null ? { requester_session: requesterSession } : {}),
      tasks: [],
      started_at: now,
      updated_at: now,
    };

    this.activeRuns.set(run.id, run);
    return {
      run_id: run.id,
      status: run.status,
      ...(orchestrator != null ? { orchestrator } : {}),
    };
  }

  /**
   * Get a run by runId, or return the single active WORKING run if no runId specified.
   * For backward compat, if only one WORKING run exists, it's returned when runId is omitted.
   */
  getRun(_team: string, runId?: string): { found: true; run: TeamRun } | { found: false } {
    if (runId) {
      const run = this.activeRuns.get(runId);
      if (run) return { found: true, run };
      return { found: false };
    }

    // No runId: single-pass to find the sole WORKING run
    let workingRun: TeamRun | undefined;
    let workingCount = 0;
    for (const r of this.activeRuns.values()) {
      if (r.status === "WORKING") {
        workingRun = r;
        workingCount++;
        if (workingCount > 1) break;
      }
    }
    if (workingCount === 1) {
      return { found: true, run: workingRun! };
    }

    // If exactly one active run (any status), use it
    if (this.activeRuns.size === 1) {
      return { found: true, run: this.activeRuns.values().next().value! };
    }

    return { found: false };
  }

  /**
   * List all active runs.
   */
  listRuns(): TeamRun[] {
    return [...this.activeRuns.values()];
  }

  /**
   * Get all active WORKING runs.
   */
  getWorkingRuns(): TeamRun[] {
    return [...this.activeRuns.values()].filter(r => r.status === "WORKING");
  }

  completeRun(
    _team: string,
    result?: string,
    runId?: string,
  ): { ok: true; status: string } {
    const run = this.resolveRun(runId);
    if (!run) {
      throw new Error(runId ? `Run "${runId}" not found.` : "No active run to complete.");
    }
    if (run.status !== "WORKING") {
      throw new Error(`Run "${run.id}" is already ${run.status}.`);
    }
    const nonTerminalTasks = run.tasks.filter(
      (task) => !TERMINAL_TASK_STATES.has(task.status),
    );
    if (nonTerminalTasks.length > 0) {
      throw new Error(
        `Cannot complete run with non-terminal tasks. Remaining: ${nonTerminalTasks.map((task) => `${task.id}:${task.status}`).join(", ")}`,
      );
    }

    const now = Date.now();
    run.status = "COMPLETED";
    run.completed_at = now;
    run.updated_at = now;
    if (result !== undefined) run.result = result;

    return { ok: true, status: "COMPLETED" };
  }

  cancelRun(
    _team: string,
    reason?: string,
    runId?: string,
  ): { ok: true; status: string; tasks_canceled: number } {
    const run = this.resolveRun(runId);
    if (!run) {
      throw new Error(runId ? `Run "${runId}" not found.` : "No active run to cancel.");
    }
    if (run.status !== "WORKING") {
      throw new Error(`Run "${run.id}" is already ${run.status}.`);
    }

    const now = Date.now();
    run.status = "CANCELED";
    run.updated_at = now;
    run.completed_at = now;
    if (reason !== undefined) run.cancel_reason = reason;

    let canceled = 0;
    for (const task of run.tasks) {
      if (task.status === "PENDING" || task.status === "WORKING") {
        task.status = "CANCELED";
        task.updated_at = now;
        canceled++;
      }
    }

    return { ok: true, status: "CANCELED", tasks_canceled: canceled };
  }

  // ── Task management ─────────────────────────────────────────────────

  /**
   * Add a task. If task.run_id is set, adds to that specific run.
   * Otherwise falls back to the single active run.
   */
  addTask(
    _team: string,
    task: Omit<TeamTask, "created_at" | "updated_at">,
  ): TeamTask {
    const run = this.resolveRun(task.run_id);
    if (!run) {
      throw new Error(task.run_id
        ? `Run "${task.run_id}" not found. Start a run first.`
        : "No active run. Start a run first.");
    }

    const now = Date.now();
    const fullTask: TeamTask = {
      ...task,
      run_id: run.id,
      created_at: now,
      updated_at: now,
    };

    run.tasks.push(fullTask);
    run.updated_at = now;

    return fullTask;
  }

  /**
   * Update a task. Searches across all active runs by taskId (globally unique).
   */
  updateTask(
    _team: string,
    taskId: string,
    updates: Partial<Pick<TeamTask, "status" | "result" | "message" | "assigned_to" | "routing_reason" | "deliverables" | "learning" | "workflow_stage">>,
  ): TeamTask | undefined {
    const { run, task } = this.findTask(taskId);
    if (!run || !task) return undefined;

    if (updates.status !== undefined) task.status = updates.status;
    if (updates.result !== undefined) task.result = updates.result;
    if (updates.message !== undefined) task.message = updates.message;
    if (updates.assigned_to !== undefined) task.assigned_to = updates.assigned_to;
    if (updates.routing_reason !== undefined) task.routing_reason = updates.routing_reason;
    if (updates.workflow_stage !== undefined) task.workflow_stage = updates.workflow_stage;

    // Merge deliverables (append, don't replace)
    if (updates.deliverables !== undefined) {
      if (!task.deliverables) task.deliverables = [];
      task.deliverables.push(...updates.deliverables);
    }

    // Set learning entry
    if (updates.learning !== undefined) task.learning = updates.learning;

    task.updated_at = Date.now();
    run.updated_at = task.updated_at;

    return task;
  }

  /**
   * Find a task by ID across all active runs.
   */
  getTask(_team: string, taskId: string): TeamTask | undefined {
    return this.findTask(taskId).task;
  }

  /**
   * Get the run that contains a specific task.
   */
  getRunForTask(taskId: string): TeamRun | undefined {
    return this.findTask(taskId).run;
  }

  /**
   * List tasks. If runId is specified, lists from that run.
   * Otherwise lists from all active runs.
   */
  listTasks(_team: string, filterStatus?: string[], runId?: string): TeamTask[] {
    let tasks: TeamTask[];

    if (runId) {
      const run = this.activeRuns.get(runId);
      tasks = run ? run.tasks : [];
    } else {
      // Collect from all active runs
      tasks = [];
      for (const run of this.activeRuns.values()) {
        tasks.push(...run.tasks);
      }
    }

    if (filterStatus && filterStatus.length > 0) {
      const allowed = new Set(filterStatus);
      tasks = tasks.filter((t) => allowed.has(t.status));
    }

    return tasks;
  }

  // ── Archive ─────────────────────────────────────────────────────────

  async archiveRun(runId?: string): Promise<void> {
    const run = this.resolveRun(runId);
    if (!run) return;

    const archiveDir = path.join(this.baseDir, "archive");
    await ensureDir(archiveDir);
    await writeJson(path.join(archiveDir, `${run.id}.json`), run);

    // Remove from active runs and delete active file
    this.activeRuns.delete(run.id);
    const activeFile = path.join(this.baseDir, "active", `${run.id}.json`);
    try {
      await fs.unlink(activeFile);
    } catch {
      // File may not exist yet if never saved
    }
  }

  /**
   * Remove a terminal (non-WORKING) run from activeRuns.
   * Call after archiving or when cleaning up completed/canceled runs.
   */
  removeRun(runId: string): boolean {
    return this.activeRuns.delete(runId);
  }

  // ── Internal ────────────────────────────────────────────────────────

  /**
   * Resolve a run: by explicit runId, or fallback to single active WORKING run.
   */
  private resolveRun(runId?: string): TeamRun | undefined {
    if (runId) {
      return this.activeRuns.get(runId);
    }
    // Fallback: single-pass to find sole WORKING run
    let workingRun: TeamRun | undefined;
    let workingCount = 0;
    for (const r of this.activeRuns.values()) {
      if (r.status === "WORKING") {
        workingRun = r;
        workingCount++;
        if (workingCount > 1) break;
      }
    }
    if (workingCount === 1) return workingRun;
    // If exactly one active run (any status), use it
    if (this.activeRuns.size === 1) return this.activeRuns.values().next().value;
    return undefined;
  }

  /**
   * Find a task by ID across all active runs.
   */
  private findTask(taskId: string): { run?: TeamRun; task?: TeamTask } {
    for (const run of this.activeRuns.values()) {
      const task = run.tasks.find((t) => t.id === taskId);
      if (task) return { run, task };
    }
    return {};
  }

  private generateRunId(): string {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const hh = String(now.getHours()).padStart(2, "0");
    const min = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");
    const rand = Math.random().toString(36).slice(2, 6);
    return `tr-${yyyy}${mm}${dd}-${hh}${min}${ss}-${rand}`;
  }
}

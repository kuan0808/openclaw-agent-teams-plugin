/**
 * TeamRun state machine.
 *
 * Manages the lifecycle of a team run and its tasks. Persists
 * the current run to `current.json` and archives completed runs.
 *
 * Methods accept a `team` parameter for interface compatibility
 * (each team has its own RunManager instance, so it's ignored internally).
 */

import type { TeamRun, TeamTask, TaskState, DeliverableEntry, StructuredLearning } from "../types.js";
import { readJson, writeJson, ensureDir } from "./persistence.js";
import * as path from "node:path";

export class RunManager {
  private currentRun: TeamRun | null = null;
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  // ── Disk I/O ────────────────────────────────────────────────────────

  async load(): Promise<void> {
    await ensureDir(this.baseDir);
    this.currentRun = await readJson<TeamRun | null>(
      path.join(this.baseDir, "current.json"),
      null,
    );
  }

  async save(): Promise<void> {
    await ensureDir(this.baseDir);
    await writeJson(
      path.join(this.baseDir, "current.json"),
      this.currentRun ?? null,
    );
  }

  // ── Run lifecycle ───────────────────────────────────────────────────

  startRun(
    team: string,
    goal: string,
    orchestrator?: string,
  ): { run_id: string; status: string; orchestrator?: string } {
    const now = Date.now();
    const run: TeamRun = {
      id: this.generateRunId(),
      team,
      goal,
      status: "WORKING",
      ...(orchestrator != null ? { orchestrator } : {}),
      tasks: [],
      started_at: now,
      updated_at: now,
    };
    this.currentRun = run;
    return {
      run_id: run.id,
      status: run.status,
      ...(orchestrator != null ? { orchestrator } : {}),
    };
  }

  getRun(_team: string): { found: true; run: TeamRun } | { found: false } {
    if (this.currentRun) {
      return { found: true, run: this.currentRun };
    }
    return { found: false };
  }

  completeRun(
    _team: string,
    result?: string,
  ): { ok: true; status: string } {
    if (!this.currentRun) {
      throw new Error("No active run to complete.");
    }
    if (this.currentRun.status !== "WORKING") {
      throw new Error(`Run "${this.currentRun.id}" is already ${this.currentRun.status}.`);
    }

    const now = Date.now();
    this.currentRun.status = "COMPLETED";
    this.currentRun.completed_at = now;
    this.currentRun.updated_at = now;
    if (result !== undefined) this.currentRun.result = result;

    return { ok: true, status: "COMPLETED" };
  }

  cancelRun(
    _team: string,
    reason?: string,
  ): { ok: true; status: string; tasks_canceled: number } {
    if (!this.currentRun) {
      throw new Error("No active run to cancel.");
    }
    if (this.currentRun.status !== "WORKING") {
      throw new Error(`Run "${this.currentRun.id}" is already ${this.currentRun.status}.`);
    }

    const now = Date.now();
    this.currentRun.status = "CANCELED";
    this.currentRun.updated_at = now;
    this.currentRun.completed_at = now;
    if (reason !== undefined) this.currentRun.cancel_reason = reason;

    let canceled = 0;
    for (const task of this.currentRun.tasks) {
      if (task.status === "PENDING" || task.status === "WORKING") {
        task.status = "CANCELED";
        task.updated_at = now;
        canceled++;
      }
    }

    return { ok: true, status: "CANCELED", tasks_canceled: canceled };
  }

  // ── Task management ─────────────────────────────────────────────────

  addTask(
    _team: string,
    task: Omit<TeamTask, "created_at" | "updated_at">,
  ): TeamTask {
    if (!this.currentRun) {
      throw new Error("No active run. Start a run first.");
    }

    const now = Date.now();
    const fullTask: TeamTask = {
      ...task,
      created_at: now,
      updated_at: now,
    };

    this.currentRun.tasks.push(fullTask);
    this.currentRun.updated_at = now;

    return fullTask;
  }

  updateTask(
    _team: string,
    taskId: string,
    updates: Partial<Pick<TeamTask, "status" | "result" | "message" | "assigned_to" | "routing_reason" | "deliverables" | "learning" | "workflow_stage">>,
  ): TeamTask | undefined {
    if (!this.currentRun) return undefined;

    const task = this.currentRun.tasks.find((t) => t.id === taskId);
    if (!task) return undefined;

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
    this.currentRun.updated_at = task.updated_at;

    return task;
  }

  getTask(_team: string, taskId: string): TeamTask | undefined {
    if (!this.currentRun) return undefined;
    return this.currentRun.tasks.find((t) => t.id === taskId);
  }

  listTasks(_team: string, filterStatus?: string[]): TeamTask[] {
    if (!this.currentRun) return [];

    let tasks = this.currentRun.tasks;

    if (filterStatus && filterStatus.length > 0) {
      const allowed = new Set(filterStatus);
      tasks = tasks.filter((t) => allowed.has(t.status));
    }

    return tasks;
  }

  // ── Archive ─────────────────────────────────────────────────────────

  async archiveRun(): Promise<void> {
    if (!this.currentRun) return;
    const archiveDir = path.join(this.baseDir, "archive");
    await ensureDir(archiveDir);
    await writeJson(path.join(archiveDir, `${this.currentRun.id}.json`), this.currentRun);
    this.currentRun = null;
  }

  // ── Internal ────────────────────────────────────────────────────────

  private generateRunId(): string {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const hh = String(now.getHours()).padStart(2, "0");
    const min = String(now.getMinutes()).padStart(2, "0");
    return `tr-${yyyy}${mm}${dd}-${hh}${min}`;
  }
}

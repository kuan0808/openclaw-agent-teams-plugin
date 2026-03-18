import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { RunManager } from "../src/state/run-manager.js";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

const tmpDir = path.join(os.tmpdir(), "at-test-rm-" + Math.random().toString(36).slice(2));

describe("RunManager", () => {
  let mgr: RunManager;

  beforeEach(async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    mgr = new RunManager(path.join(tmpDir, "runs"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ── startRun ─────────────────────────────────────────────────────────

  it("startRun creates a run with WORKING status", () => {
    const result = mgr.startRun("team-a", "Build feature X", "lead");
    expect(result.status).toBe("WORKING");
    expect(result.run_id).toMatch(/^tr-/);
    expect(result.orchestrator).toBe("lead");
  });

  // ── getRun ───────────────────────────────────────────────────────────

  it("getRun returns the current run", () => {
    mgr.startRun("team-a", "Build feature X");
    const result = mgr.getRun("team-a");
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.run.goal).toBe("Build feature X");
      expect(result.run.status).toBe("WORKING");
    }
  });

  it("getRun returns { found: false } when no run", () => {
    const result = mgr.getRun("team-a");
    expect(result).toEqual({ found: false });
  });

  it("getRun finds run by explicit runId", () => {
    const { run_id } = mgr.startRun("team-a", "Find me");
    const result = mgr.getRun("team-a", run_id);
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.run.goal).toBe("Find me");
    }
  });

  // ── addTask ──────────────────────────────────────────────────────────

  it("addTask adds task to current run", () => {
    const { run_id } = mgr.startRun("team-a", "Goal");
    const task = mgr.addTask("team-a", {
      id: "task-1",
      team: "team-a",
      run_id,
      description: "Do something",
      status: "PENDING",
    });

    expect(task.id).toBe("task-1");
    expect(task.status).toBe("PENDING");
    expect(task.created_at).toBeGreaterThan(0);
  });

  it("addTask falls back to the single active run when run_id is omitted", () => {
    mgr.startRun("team-a", "Goal");
    const task = mgr.addTask("team-a", {
      id: "task-fallback",
      team: "team-a",
      run_id: "",        // empty string — resolveRun treats falsy as "no id"
      description: "Fallback task",
      status: "PENDING",
    });
    expect(task.id).toBe("task-fallback");
    expect(task.run_id).toMatch(/^tr-/);
  });

  // ── updateTask ───────────────────────────────────────────────────────

  it("updateTask updates task fields", () => {
    const { run_id } = mgr.startRun("team-a", "Goal");
    mgr.addTask("team-a", {
      id: "task-1",
      team: "team-a",
      run_id,
      description: "Do something",
      status: "PENDING",
    });

    const updated = mgr.updateTask("team-a", "task-1", {
      status: "WORKING",
      message: "In progress",
    });
    expect(updated).toBeDefined();
    expect(updated!.status).toBe("WORKING");
    expect(updated!.message).toBe("In progress");
  });

  // ── getTask ──────────────────────────────────────────────────────────

  it("getTask finds task by id", () => {
    const { run_id } = mgr.startRun("team-a", "Goal");
    mgr.addTask("team-a", {
      id: "task-1",
      team: "team-a",
      run_id,
      description: "Do something",
      status: "PENDING",
    });

    const task = mgr.getTask("team-a", "task-1");
    expect(task).toBeDefined();
    expect(task!.id).toBe("task-1");
  });

  // ── listTasks ────────────────────────────────────────────────────────

  it("listTasks returns all tasks", () => {
    const { run_id } = mgr.startRun("team-a", "Goal");
    mgr.addTask("team-a", {
      id: "t1", team: "team-a", run_id,
      description: "Task 1", status: "PENDING",
    });
    mgr.addTask("team-a", {
      id: "t2", team: "team-a", run_id,
      description: "Task 2", status: "WORKING",
    });

    const tasks = mgr.listTasks("team-a");
    expect(tasks).toHaveLength(2);
  });

  it("listTasks filters by status", () => {
    const { run_id } = mgr.startRun("team-a", "Goal");
    mgr.addTask("team-a", {
      id: "t1", team: "team-a", run_id,
      description: "Task 1", status: "PENDING",
    });
    mgr.addTask("team-a", {
      id: "t2", team: "team-a", run_id,
      description: "Task 2", status: "WORKING",
    });
    mgr.addTask("team-a", {
      id: "t3", team: "team-a", run_id,
      description: "Task 3", status: "COMPLETED",
    });

    const pending = mgr.listTasks("team-a", ["PENDING"]);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe("t1");

    const active = mgr.listTasks("team-a", ["PENDING", "WORKING"]);
    expect(active).toHaveLength(2);
  });

  // ── completeRun ──────────────────────────────────────────────────────

  it("completeRun sets status to COMPLETED", () => {
    mgr.startRun("team-a", "Goal");
    const result = mgr.completeRun("team-a", "All done");
    expect(result).toEqual({ ok: true, status: "COMPLETED" });

    const run = mgr.getRun("team-a");
    expect(run.found).toBe(true);
    if (run.found) {
      expect(run.run.status).toBe("COMPLETED");
      expect(run.run.result).toBe("All done");
      expect(run.run.completed_at).toBeGreaterThan(0);
    }
  });

  it("completeRun rejects runs with non-terminal tasks", () => {
    const { run_id } = mgr.startRun("team-a", "Goal");
    mgr.addTask("team-a", {
      id: "t1",
      team: "team-a",
      run_id,
      description: "Task 1",
      status: "WORKING",
    });

    expect(() => mgr.completeRun("team-a", "Too early")).toThrow(
      /non-terminal tasks/i,
    );
  });

  // ── cancelRun ────────────────────────────────────────────────────────

  it("cancelRun cancels PENDING/WORKING tasks", () => {
    const { run_id } = mgr.startRun("team-a", "Goal");
    mgr.addTask("team-a", {
      id: "t1", team: "team-a", run_id,
      description: "Task 1", status: "PENDING",
    });
    mgr.addTask("team-a", {
      id: "t2", team: "team-a", run_id,
      description: "Task 2", status: "WORKING",
    });
    mgr.addTask("team-a", {
      id: "t3", team: "team-a", run_id,
      description: "Task 3", status: "COMPLETED",
    });

    const result = mgr.cancelRun("team-a", "Aborted");
    expect(result).toEqual({ ok: true, status: "CANCELED", tasks_canceled: 2 });

    const t1 = mgr.getTask("team-a", "t1");
    const t2 = mgr.getTask("team-a", "t2");
    const t3 = mgr.getTask("team-a", "t3");
    expect(t1!.status).toBe("CANCELED");
    expect(t2!.status).toBe("CANCELED");
    expect(t3!.status).toBe("COMPLETED"); // not canceled
  });

  // ── Persistence ──────────────────────────────────────────────────────

  it("save/load roundtrip", async () => {
    const dir = path.join(tmpDir, "persist-runs");
    const m1 = new RunManager(dir);
    const { run_id } = m1.startRun("team-a", "Persist test", "lead");
    m1.addTask("team-a", {
      id: "t1", team: "team-a", run_id,
      description: "Task 1", status: "PENDING",
    });
    await m1.save();

    const m2 = new RunManager(dir);
    await m2.load();

    const run = m2.getRun("team-a");
    expect(run.found).toBe(true);
    if (run.found) {
      expect(run.run.goal).toBe("Persist test");
      expect(run.run.tasks).toHaveLength(1);
      expect(run.run.tasks[0]!.id).toBe("t1");
    }
  });

  it("save/load writes to active/<runId>.json, not current.json", async () => {
    const dir = path.join(tmpDir, "active-path-runs");
    const m1 = new RunManager(dir);
    const { run_id } = m1.startRun("team-a", "Active path test");
    await m1.save();

    // File must exist at active/<runId>.json
    const activeFile = path.join(dir, "active", `${run_id}.json`);
    await expect(fs.access(activeFile)).resolves.toBeUndefined();

    // Legacy current.json must NOT be written
    const legacyFile = path.join(dir, "current.json");
    await expect(fs.access(legacyFile)).rejects.toThrow();
  });

  // ── Concurrent runs ──────────────────────────────────────────────────

  it("supports multiple concurrent WORKING runs", () => {
    const r1 = mgr.startRun("team-a", "Run 1");
    const r2 = mgr.startRun("team-a", "Run 2");

    expect(r1.run_id).not.toBe(r2.run_id);

    const runs = mgr.listRuns();
    expect(runs).toHaveLength(2);
    expect(mgr.getWorkingRuns()).toHaveLength(2);
  });

  it("addTask routes to the correct run when multiple runs are active", () => {
    const r1 = mgr.startRun("team-a", "Run 1");
    const r2 = mgr.startRun("team-a", "Run 2");

    mgr.addTask("team-a", {
      id: "task-for-r1", team: "team-a", run_id: r1.run_id,
      description: "Belongs to run 1", status: "PENDING",
    });
    mgr.addTask("team-a", {
      id: "task-for-r2", team: "team-a", run_id: r2.run_id,
      description: "Belongs to run 2", status: "PENDING",
    });

    const tasks1 = mgr.listTasks("team-a", undefined, r1.run_id);
    const tasks2 = mgr.listTasks("team-a", undefined, r2.run_id);

    expect(tasks1).toHaveLength(1);
    expect(tasks1[0]!.id).toBe("task-for-r1");
    expect(tasks2).toHaveLength(1);
    expect(tasks2[0]!.id).toBe("task-for-r2");
  });

  it("listTasks without runId aggregates across all concurrent runs", () => {
    const r1 = mgr.startRun("team-a", "Run 1");
    const r2 = mgr.startRun("team-a", "Run 2");

    mgr.addTask("team-a", {
      id: "t-r1", team: "team-a", run_id: r1.run_id,
      description: "In run 1", status: "PENDING",
    });
    mgr.addTask("team-a", {
      id: "t-r2", team: "team-a", run_id: r2.run_id,
      description: "In run 2", status: "WORKING",
    });

    const all = mgr.listTasks("team-a");
    expect(all).toHaveLength(2);
  });

  it("completeRun targets specific run by runId when multiple are active", () => {
    const r1 = mgr.startRun("team-a", "Run 1");
    mgr.startRun("team-a", "Run 2");

    const result = mgr.completeRun("team-a", "Run 1 done", r1.run_id);
    expect(result).toEqual({ ok: true, status: "COMPLETED" });

    // run 1 completed, run 2 still WORKING
    const run1 = mgr.getRun("team-a", r1.run_id);
    expect(run1.found).toBe(true);
    if (run1.found) expect(run1.run.status).toBe("COMPLETED");

    expect(mgr.getWorkingRuns()).toHaveLength(1);
  });

  it("cancelRun targets specific run by runId when multiple are active", () => {
    const r1 = mgr.startRun("team-a", "Run 1");
    const r2 = mgr.startRun("team-a", "Run 2");

    mgr.addTask("team-a", {
      id: "t-r1", team: "team-a", run_id: r1.run_id,
      description: "Run 1 task", status: "PENDING",
    });
    mgr.addTask("team-a", {
      id: "t-r2", team: "team-a", run_id: r2.run_id,
      description: "Run 2 task", status: "PENDING",
    });

    mgr.cancelRun("team-a", "Cancel run 1", r1.run_id);

    expect(mgr.getTask("team-a", "t-r1")!.status).toBe("CANCELED");
    expect(mgr.getTask("team-a", "t-r2")!.status).toBe("PENDING"); // untouched
    expect(mgr.getWorkingRuns()).toHaveLength(1);
  });

  it("save/load roundtrip preserves multiple concurrent runs", async () => {
    const dir = path.join(tmpDir, "concurrent-persist");
    const m1 = new RunManager(dir);
    const r1 = m1.startRun("team-a", "Concurrent run 1");
    const r2 = m1.startRun("team-a", "Concurrent run 2");

    m1.addTask("team-a", {
      id: "ta", team: "team-a", run_id: r1.run_id,
      description: "Task A", status: "PENDING",
    });
    m1.addTask("team-a", {
      id: "tb", team: "team-a", run_id: r2.run_id,
      description: "Task B", status: "WORKING",
    });
    await m1.save();

    const m2 = new RunManager(dir);
    await m2.load();

    expect(m2.listRuns()).toHaveLength(2);
    expect(m2.getTask("team-a", "ta")).toBeDefined();
    expect(m2.getTask("team-a", "tb")).toBeDefined();
  });

  it("getRunForTask returns the run that owns the task", () => {
    const r1 = mgr.startRun("team-a", "Run 1");
    const r2 = mgr.startRun("team-a", "Run 2");

    mgr.addTask("team-a", {
      id: "t-owned", team: "team-a", run_id: r2.run_id,
      description: "Owned by run 2", status: "PENDING",
    });

    const owningRun = mgr.getRunForTask("t-owned");
    expect(owningRun).toBeDefined();
    expect(owningRun!.id).toBe(r2.run_id);
  });

  it("removeRun deletes the run from active set", () => {
    const { run_id } = mgr.startRun("team-a", "To be removed");
    expect(mgr.listRuns()).toHaveLength(1);

    const removed = mgr.removeRun(run_id);
    expect(removed).toBe(true);
    expect(mgr.listRuns()).toHaveLength(0);
  });
});

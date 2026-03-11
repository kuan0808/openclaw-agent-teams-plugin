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

  // ── addTask ──────────────────────────────────────────────────────────

  it("addTask adds task to current run", () => {
    mgr.startRun("team-a", "Goal");
    const task = mgr.addTask("team-a", {
      id: "task-1",
      team: "team-a",
      run_id: "tr-1",
      description: "Do something",
      status: "PENDING",
    });

    expect(task.id).toBe("task-1");
    expect(task.status).toBe("PENDING");
    expect(task.created_at).toBeGreaterThan(0);
  });

  // ── updateTask ───────────────────────────────────────────────────────

  it("updateTask updates task fields", () => {
    mgr.startRun("team-a", "Goal");
    mgr.addTask("team-a", {
      id: "task-1",
      team: "team-a",
      run_id: "tr-1",
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
    mgr.startRun("team-a", "Goal");
    mgr.addTask("team-a", {
      id: "task-1",
      team: "team-a",
      run_id: "tr-1",
      description: "Do something",
      status: "PENDING",
    });

    const task = mgr.getTask("team-a", "task-1");
    expect(task).toBeDefined();
    expect(task!.id).toBe("task-1");
  });

  // ── listTasks ────────────────────────────────────────────────────────

  it("listTasks returns all tasks", () => {
    mgr.startRun("team-a", "Goal");
    mgr.addTask("team-a", {
      id: "t1", team: "team-a", run_id: "tr-1",
      description: "Task 1", status: "PENDING",
    });
    mgr.addTask("team-a", {
      id: "t2", team: "team-a", run_id: "tr-1",
      description: "Task 2", status: "WORKING",
    });

    const tasks = mgr.listTasks("team-a");
    expect(tasks).toHaveLength(2);
  });

  it("listTasks filters by status", () => {
    mgr.startRun("team-a", "Goal");
    mgr.addTask("team-a", {
      id: "t1", team: "team-a", run_id: "tr-1",
      description: "Task 1", status: "PENDING",
    });
    mgr.addTask("team-a", {
      id: "t2", team: "team-a", run_id: "tr-1",
      description: "Task 2", status: "WORKING",
    });
    mgr.addTask("team-a", {
      id: "t3", team: "team-a", run_id: "tr-1",
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

  // ── cancelRun ────────────────────────────────────────────────────────

  it("cancelRun cancels PENDING/WORKING tasks", () => {
    mgr.startRun("team-a", "Goal");
    mgr.addTask("team-a", {
      id: "t1", team: "team-a", run_id: "tr-1",
      description: "Task 1", status: "PENDING",
    });
    mgr.addTask("team-a", {
      id: "t2", team: "team-a", run_id: "tr-1",
      description: "Task 2", status: "WORKING",
    });
    mgr.addTask("team-a", {
      id: "t3", team: "team-a", run_id: "tr-1",
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
    m1.startRun("team-a", "Persist test", "lead");
    m1.addTask("team-a", {
      id: "t1", team: "team-a", run_id: "tr-1",
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
});

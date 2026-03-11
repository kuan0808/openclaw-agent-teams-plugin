import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { RunManager } from "../src/state/run-manager.js";

const tmpDir = path.join(os.tmpdir(), "at-test-deliv-" + Math.random().toString(36).slice(2));

describe("Deliverables & Gates (RunManager)", () => {
  let runs: RunManager;

  beforeEach(async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    runs = new RunManager(path.join(tmpDir, "runs"));
    await runs.load();
    runs.startRun("dev", "Test goal");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ── Deliverables ──────────────────────────────────────────────────

  it("should store deliverables on task update", () => {
    runs.addTask("dev", {
      id: "task-1",
      team: "dev",
      run_id: "tr-001",
      description: "Build feature",
      status: "WORKING",
    });

    const updated = runs.updateTask("dev", "task-1", {
      deliverables: [
        { type: "file", path: "/output/report.md", description: "Report", created_by: "alice", created_at: Date.now() },
      ],
    });

    expect(updated).toBeDefined();
    expect(updated!.deliverables).toHaveLength(1);
    expect(updated!.deliverables![0]!.type).toBe("file");
    expect(updated!.deliverables![0]!.path).toBe("/output/report.md");
  });

  it("should append deliverables (not replace)", () => {
    runs.addTask("dev", {
      id: "task-1",
      team: "dev",
      run_id: "tr-001",
      description: "Build feature",
      status: "WORKING",
    });

    runs.updateTask("dev", "task-1", {
      deliverables: [
        { type: "file", path: "/a.txt", description: "File A", created_by: "alice", created_at: Date.now() },
      ],
    });

    runs.updateTask("dev", "task-1", {
      deliverables: [
        { type: "url", url: "https://example.com", description: "Link B", created_by: "alice", created_at: Date.now() },
      ],
    });

    const task = runs.getTask("dev", "task-1");
    expect(task!.deliverables).toHaveLength(2);
    expect(task!.deliverables![0]!.type).toBe("file");
    expect(task!.deliverables![1]!.type).toBe("url");
  });

  it("should store doc-type deliverables referencing DocPool", () => {
    runs.addTask("dev", {
      id: "task-1",
      team: "dev",
      run_id: "tr-001",
      description: "Analysis",
      status: "WORKING",
    });

    const updated = runs.updateTask("dev", "task-1", {
      deliverables: [
        { type: "doc", doc_key: "analysis-results", description: "Full analysis", created_by: "bob", created_at: Date.now() },
      ],
    });

    expect(updated!.deliverables![0]!.doc_key).toBe("analysis-results");
  });

  // ── Learning ──────────────────────────────────────────────────────

  it("should store structured learning on task update", () => {
    runs.addTask("dev", {
      id: "task-1",
      team: "dev",
      run_id: "tr-001",
      description: "Test task",
      status: "WORKING",
    });

    const updated = runs.updateTask("dev", "task-1", {
      learning: {
        content: "Always check return codes",
        confidence: 0.85,
        category: "pattern",
        task_id: "task-1",
        timestamp: Date.now(),
      },
    });

    expect(updated!.learning).toBeDefined();
    expect(updated!.learning!.content).toBe("Always check return codes");
    expect(updated!.learning!.confidence).toBe(0.85);
    expect(updated!.learning!.category).toBe("pattern");
  });

  // ── Workflow stage ────────────────────────────────────────────────

  it("should store workflow_stage on task update", () => {
    runs.addTask("dev", {
      id: "task-1",
      team: "dev",
      run_id: "tr-001",
      description: "Stage task",
      status: "PENDING",
    });

    const updated = runs.updateTask("dev", "task-1", {
      workflow_stage: "implement",
    });

    expect(updated!.workflow_stage).toBe("implement");
  });

  // ── Persistence of new fields ──────────────────────────────────────

  it("should persist deliverables and learning through save/load", async () => {
    runs.addTask("dev", {
      id: "task-1",
      team: "dev",
      run_id: "tr-001",
      description: "Persist test",
      status: "WORKING",
    });

    runs.updateTask("dev", "task-1", {
      deliverables: [
        { type: "file", path: "/a.txt", description: "File", created_by: "alice", created_at: 1000 },
      ],
      learning: {
        content: "Important pattern",
        confidence: 0.9,
        category: "pattern",
        task_id: "task-1",
        timestamp: 2000,
      },
    });

    await runs.save();

    const reloaded = new RunManager(path.join(tmpDir, "runs"));
    await reloaded.load();

    const task = reloaded.getTask("dev", "task-1");
    expect(task).toBeDefined();
    expect(task!.deliverables).toHaveLength(1);
    expect(task!.deliverables![0]!.path).toBe("/a.txt");
    expect(task!.learning!.content).toBe("Important pattern");
    expect(task!.learning!.confidence).toBe(0.9);
  });
});

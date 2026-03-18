import { describe, it, expect } from "vitest";
import { generateTaskChain, handleFailLoopback } from "../src/workflow/template-engine.js";
import type { TeamConfig, TeamTask, WorkflowTemplate } from "../src/types.js";

// ── Test fixtures ─────────────────────────────────────────────────────

const standardTemplate: WorkflowTemplate = {
  stages: [
    { name: "implement", role: "builder", skills: ["coding"] },
    { name: "test", role: "tester", skills: ["testing"] },
    { name: "review", role: "reviewer", skills: ["code-review"] },
  ],
  fail_handlers: {
    test: "implement",
    review: "implement",
  },
};

const teamConfig: TeamConfig = {
  description: "Dev team",
  coordination: "orchestrator",
  orchestrator: "lead",
  members: {
    lead: { role: "Team lead and orchestrator" },
    builder: { role: "builder", skills: ["coding"] },
    tester: { role: "tester", skills: ["testing"] },
    reviewer: { role: "reviewer", skills: ["code-review"] },
  },
};

describe("Workflow Template Engine", () => {
  // ── generateTaskChain ──────────────────────────────────────────────

  describe("generateTaskChain", () => {
    it("should generate tasks for all stages", () => {
      const tasks = generateTaskChain(standardTemplate, "Build feature X", teamConfig, "tr-001", []);
      expect(tasks).toHaveLength(3);
      expect(tasks[0]!.workflow_stage).toBe("implement");
      expect(tasks[1]!.workflow_stage).toBe("test");
      expect(tasks[2]!.workflow_stage).toBe("review");
    });

    it("should set first stage to PENDING, rest to BLOCKED", () => {
      const tasks = generateTaskChain(standardTemplate, "Build feature X", teamConfig, "tr-001", []);
      expect(tasks[0]!.status).toBe("PENDING");
      expect(tasks[1]!.status).toBe("BLOCKED");
      expect(tasks[2]!.status).toBe("BLOCKED");
    });

    it("should chain dependencies: each stage depends on previous", () => {
      const tasks = generateTaskChain(standardTemplate, "Build feature X", teamConfig, "tr-001", []);
      expect(tasks[0]!.depends_on).toBeUndefined();
      expect(tasks[1]!.depends_on).toEqual([tasks[0]!.id]);
      expect(tasks[2]!.depends_on).toEqual([tasks[1]!.id]);
    });

    it("should include goal in task descriptions", () => {
      const tasks = generateTaskChain(standardTemplate, "Build feature X", teamConfig, "tr-001", []);
      expect(tasks[0]!.description).toContain("implement");
      expect(tasks[0]!.description).toContain("Build feature X");
    });

    it("should route by role when available", () => {
      const tasks = generateTaskChain(standardTemplate, "Build feature X", teamConfig, "tr-001", []);
      expect(tasks[0]!.assigned_to).toBe("builder");
      expect(tasks[1]!.assigned_to).toBe("tester");
      expect(tasks[2]!.assigned_to).toBe("reviewer");
    });

    it("should generate unique task IDs using run ID", () => {
      const tasks = generateTaskChain(standardTemplate, "Goal", teamConfig, "tr-001", []);
      expect(tasks[0]!.id).toContain("tr-001");
      expect(tasks[0]!.id).toContain("implement");
      // All IDs should be unique
      const ids = new Set(tasks.map((t) => t.id));
      expect(ids.size).toBe(tasks.length);
    });
  });

  // ── handleFailLoopback ────────────────────────────────────────────

  describe("handleFailLoopback", () => {
    function makeTask(overrides: Partial<TeamTask>): TeamTask {
      return {
        id: "task-1",
        team: "dev",
        run_id: "tr-001",
        description: "Test task",
        status: "WORKING",
        created_at: Date.now(),
        updated_at: Date.now(),
        ...overrides,
      };
    }

    it("should create rework task when test fails", () => {
      const failedTask = makeTask({
        id: "task-tr-001-stage-test",
        workflow_stage: "test",
        status: "FAILED",
        message: "Tests failed: 3 assertions broken",
      });

      const allTasks = [
        makeTask({ id: "task-tr-001-stage-implement", workflow_stage: "implement", status: "COMPLETED" }),
        failedTask,
        makeTask({ id: "task-tr-001-stage-review", workflow_stage: "review", status: "BLOCKED" }),
      ];

      const result = handleFailLoopback(standardTemplate, "test", failedTask, allTasks, teamConfig, "tr-001");
      expect(result).not.toBeNull();
      expect(result!.reworkTask.workflow_stage).toBe("implement");
      expect(result!.reworkTask.status).toBe("PENDING");
      expect(result!.reworkTask.description).toContain("rework");
      expect(result!.reworkTask.description).toContain("Tests failed");
    });

    it("should re-block downstream tasks on fail-loopback", () => {
      const failedTask = makeTask({
        id: "task-tr-001-stage-test",
        workflow_stage: "test",
        status: "FAILED",
      });

      const allTasks = [
        makeTask({ id: "task-tr-001-stage-implement", workflow_stage: "implement", status: "COMPLETED" }),
        failedTask,
        makeTask({ id: "task-tr-001-stage-review", workflow_stage: "review", status: "PENDING" }),
      ];

      const result = handleFailLoopback(standardTemplate, "test", failedTask, allTasks, teamConfig, "tr-001");
      expect(result).not.toBeNull();
      expect(result!.tasksToReblock).toContain("task-tr-001-stage-review");
    });

    it("should return null for stages without fail handlers", () => {
      const failedTask = makeTask({
        id: "task-stage-implement",
        workflow_stage: "implement",
        status: "FAILED",
      });

      const result = handleFailLoopback(standardTemplate, "implement", failedTask, [], teamConfig, "tr-001");
      expect(result).toBeNull();
    });

    it("should return null when template has no fail handlers", () => {
      const templateNoFail: WorkflowTemplate = {
        stages: [{ name: "build" }, { name: "test" }],
      };

      const failedTask = makeTask({ workflow_stage: "test", status: "FAILED" });
      const result = handleFailLoopback(templateNoFail, "test", failedTask, [], teamConfig, "tr-001");
      expect(result).toBeNull();
    });
  });
});

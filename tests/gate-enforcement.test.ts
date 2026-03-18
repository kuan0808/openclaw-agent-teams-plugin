import { describe, it, expect } from "vitest";
import { enforceGates } from "../src/tools/team-task.js";
import type { GateConfig, TeamConfig, TeamTask } from "../src/types.js";

function makeTask(overrides?: Partial<TeamTask>): TeamTask {
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

const teamConfig: TeamConfig = {
  description: "Dev team",
  coordination: "orchestrator",
  orchestrator: "lead",
  members: {
    lead: { role: "Team lead" },
    builder: { role: "Builder" },
  },
};

describe("enforceGates", () => {
  // ── No gates ──────────────────────────────────────────────────────

  it("should return null when no gates configured", () => {
    const result = enforceGates(undefined, "COMPLETED", makeTask(), {} as any, "builder", teamConfig);
    expect(result).toBeNull();
  });

  it("should return null when target status has no gate", () => {
    const gates: Record<string, GateConfig> = {
      COMPLETED: { require_deliverables: true },
    };
    const result = enforceGates(gates, "WORKING", makeTask(), {} as any, "builder", teamConfig);
    expect(result).toBeNull();
  });

  // ── require_deliverables ──────────────────────────────────────────

  it("should block when deliverables required but none exist", () => {
    const gates: Record<string, GateConfig> = {
      COMPLETED: { require_deliverables: true },
    };
    const result = enforceGates(gates, "COMPLETED", makeTask(), {} as any, "builder", teamConfig);
    expect(result).not.toBeNull();
    expect(result).toContain("requires at least one deliverable");
  });

  it("should allow when task already has deliverables", () => {
    const gates: Record<string, GateConfig> = {
      COMPLETED: { require_deliverables: true },
    };
    const task = makeTask({
      deliverables: [{ type: "file", path: "/a.txt", description: "File", created_by: "alice", created_at: 1 }],
    });
    const result = enforceGates(gates, "COMPLETED", task, {} as any, "builder", teamConfig);
    expect(result).toBeNull();
  });

  it("should allow when new deliverables being added in same update", () => {
    const gates: Record<string, GateConfig> = {
      COMPLETED: { require_deliverables: true },
    };
    const params = {
      deliverables: [{ type: "file", path: "/b.txt" }],
    } as any;
    const result = enforceGates(gates, "COMPLETED", makeTask(), params, "builder", teamConfig);
    expect(result).toBeNull();
  });

  // ── require_result ────────────────────────────────────────────────

  it("should block when result required but not provided", () => {
    const gates: Record<string, GateConfig> = {
      COMPLETED: { require_result: true },
    };
    const result = enforceGates(gates, "COMPLETED", makeTask(), {} as any, "builder", teamConfig);
    expect(result).not.toBeNull();
    expect(result).toContain("requires a result summary");
  });

  it("should allow when result provided in params", () => {
    const gates: Record<string, GateConfig> = {
      COMPLETED: { require_result: true },
    };
    const params = { result: "Task completed successfully" } as any;
    const result = enforceGates(gates, "COMPLETED", makeTask(), params, "builder", teamConfig);
    expect(result).toBeNull();
  });

  it("should allow when task already has result", () => {
    const gates: Record<string, GateConfig> = {
      COMPLETED: { require_result: true },
    };
    const task = makeTask({ result: "Previous result" });
    const result = enforceGates(gates, "COMPLETED", task, {} as any, "builder", teamConfig);
    expect(result).toBeNull();
  });

  // ── approver ──────────────────────────────────────────────────────

  it("should block when wrong member tries to approve", () => {
    const gates: Record<string, GateConfig> = {
      COMPLETED: { approver: "orchestrator" },
    };
    const result = enforceGates(gates, "COMPLETED", makeTask(), {} as any, "builder", teamConfig);
    expect(result).not.toBeNull();
    expect(result).toContain('only "lead"');
  });

  it("should allow when orchestrator approves", () => {
    const gates: Record<string, GateConfig> = {
      COMPLETED: { approver: "orchestrator" },
    };
    const result = enforceGates(gates, "COMPLETED", makeTask(), {} as any, "lead", teamConfig);
    expect(result).toBeNull();
  });

  it("should allow __leader__ to bypass approver gate", () => {
    const gates: Record<string, GateConfig> = {
      COMPLETED: { approver: "orchestrator" },
    };
    const result = enforceGates(gates, "COMPLETED", makeTask(), {} as any, "__leader__", teamConfig);
    expect(result).toBeNull();
  });

  it("should enforce specific named approver", () => {
    const gates: Record<string, GateConfig> = {
      COMPLETED: { approver: "reviewer" },
    };
    const result = enforceGates(gates, "COMPLETED", makeTask(), {} as any, "builder", teamConfig);
    expect(result).not.toBeNull();
    expect(result).toContain('"reviewer"');
  });

  // ── reviewer (for REVISION_REQUESTED) ───────────────────────────

  it("should block when wrong member tries to request revision (reviewer gate)", () => {
    const gates: Record<string, GateConfig> = {
      REVISION_REQUESTED: { reviewer: "orchestrator" },
    };
    const result = enforceGates(gates, "REVISION_REQUESTED", makeTask({ status: "COMPLETED" }), {} as any, "builder", teamConfig);
    expect(result).not.toBeNull();
    expect(result).toContain('only "lead"');
    expect(result).toContain("revisions");
  });

  it("should allow orchestrator to request revision (reviewer gate)", () => {
    const gates: Record<string, GateConfig> = {
      REVISION_REQUESTED: { reviewer: "orchestrator" },
    };
    const result = enforceGates(gates, "REVISION_REQUESTED", makeTask({ status: "COMPLETED" }), {} as any, "lead", teamConfig);
    expect(result).toBeNull();
  });

  it("should allow __leader__ to bypass reviewer gate", () => {
    const gates: Record<string, GateConfig> = {
      REVISION_REQUESTED: { reviewer: "orchestrator" },
    };
    const result = enforceGates(gates, "REVISION_REQUESTED", makeTask({ status: "COMPLETED" }), {} as any, "__leader__", teamConfig);
    expect(result).toBeNull();
  });

  it("should enforce specific named reviewer", () => {
    const gates: Record<string, GateConfig> = {
      REVISION_REQUESTED: { reviewer: "qa_lead" },
    };
    const result = enforceGates(gates, "REVISION_REQUESTED", makeTask({ status: "COMPLETED" }), {} as any, "builder", teamConfig);
    expect(result).not.toBeNull();
    expect(result).toContain('"qa_lead"');
  });

  // ── Combined gates ────────────────────────────────────────────────

  it("should check all gates and fail on first violation", () => {
    const gates: Record<string, GateConfig> = {
      COMPLETED: {
        require_deliverables: true,
        require_result: true,
        approver: "orchestrator",
      },
    };
    // No deliverables → should fail on deliverables first
    const result = enforceGates(gates, "COMPLETED", makeTask(), {} as any, "builder", teamConfig);
    expect(result).not.toBeNull();
    expect(result).toContain("deliverable");
  });

  it("should pass when all gates satisfied", () => {
    const gates: Record<string, GateConfig> = {
      COMPLETED: {
        require_deliverables: true,
        require_result: true,
        approver: "orchestrator",
      },
    };
    const task = makeTask({
      deliverables: [{ type: "file", path: "/a.txt", description: "File", created_by: "lead", created_at: 1 }],
    });
    const params = { result: "Done" } as any;
    const result = enforceGates(gates, "COMPLETED", task, params, "lead", teamConfig);
    expect(result).toBeNull();
  });
});

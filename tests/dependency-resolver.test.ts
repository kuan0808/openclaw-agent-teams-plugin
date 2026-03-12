import { describe, it, expect, vi, afterEach } from "vitest";
import {
  resolveDependencies,
  shouldBlock,
  cascadeCancelDependents,
} from "../src/routing/dependency-resolver.js";
import type { TeamTask, TaskState } from "../src/types.js";

function makeTask(id: string, status: TaskState, deps?: string[]): TeamTask {
  return {
    id,
    team: "test",
    run_id: "tr-1",
    description: `Task ${id}`,
    status,
    depends_on: deps,
    created_at: Date.now(),
    updated_at: Date.now(),
  };
}

describe("shouldBlock", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns true if any dep is not COMPLETED", () => {
    const tasks = [
      makeTask("t1", "COMPLETED"),
      makeTask("t2", "WORKING"),
    ];
    expect(shouldBlock(tasks, ["t1", "t2"])).toBe(true);
  });

  it("returns false if all deps are COMPLETED", () => {
    const tasks = [
      makeTask("t1", "COMPLETED"),
      makeTask("t2", "COMPLETED"),
    ];
    expect(shouldBlock(tasks, ["t1", "t2"])).toBe(false);
  });

  it("returns false for empty deps", () => {
    const tasks = [makeTask("t1", "WORKING")];
    expect(shouldBlock(tasks, [])).toBe(false);
  });
});

describe("resolveDependencies", () => {
  afterEach(() => vi.restoreAllMocks());

  it("unblocks BLOCKED task when all deps complete", () => {
    const tasks = [
      makeTask("t1", "COMPLETED"),
      makeTask("t2", "BLOCKED", ["t1"]),
    ];

    const unblocked = resolveDependencies(tasks, "t1");
    expect(unblocked).toHaveLength(1);
    expect(unblocked[0]!.id).toBe("t2");
    expect(tasks[1]!.status).toBe("PENDING");
  });

  it("doesn't unblock if some deps still pending", () => {
    const tasks = [
      makeTask("t1", "COMPLETED"),
      makeTask("t2", "WORKING"),
      makeTask("t3", "BLOCKED", ["t1", "t2"]),
    ];

    const unblocked = resolveDependencies(tasks, "t1");
    expect(unblocked).toHaveLength(0);
    expect(tasks[2]!.status).toBe("BLOCKED");
  });

  it("handles multiple blocked tasks", () => {
    const tasks = [
      makeTask("t1", "COMPLETED"),
      makeTask("t2", "BLOCKED", ["t1"]),
      makeTask("t3", "BLOCKED", ["t1"]),
    ];

    const unblocked = resolveDependencies(tasks, "t1");
    expect(unblocked).toHaveLength(2);
    expect(tasks[1]!.status).toBe("PENDING");
    expect(tasks[2]!.status).toBe("PENDING");
  });
});

describe("cascadeCancelDependents", () => {
  afterEach(() => vi.restoreAllMocks());

  it("cancels direct dependents", () => {
    const tasks = [
      makeTask("t1", "CANCELED"),
      makeTask("t2", "BLOCKED", ["t1"]),
      makeTask("t3", "PENDING", ["t1"]),
    ];

    const canceled = cascadeCancelDependents(tasks, "t1");
    expect(canceled).toHaveLength(2);
    expect(tasks[1]!.status).toBe("CANCELED");
    expect(tasks[2]!.status).toBe("CANCELED");
  });

  it("cascades transitively (A -> B -> C)", () => {
    const tasks = [
      makeTask("A", "CANCELED"),
      makeTask("B", "BLOCKED", ["A"]),
      makeTask("C", "PENDING", ["B"]),
    ];

    const canceled = cascadeCancelDependents(tasks, "A");
    expect(canceled).toHaveLength(2);
    expect(tasks[1]!.status).toBe("CANCELED");
    expect(tasks[2]!.status).toBe("CANCELED");
  });

  it("cancels WORKING tasks (auto-WORKING means not yet meaningfully started)", () => {
    const tasks = [
      makeTask("t1", "CANCELED"),
      makeTask("t2", "WORKING", ["t1"]),  // auto-WORKING — should cancel
      makeTask("t3", "BLOCKED", ["t1"]),  // blocked — should cancel
    ];

    const canceled = cascadeCancelDependents(tasks, "t1");
    expect(canceled).toHaveLength(2);
    expect(tasks[1]!.status).toBe("CANCELED");
    expect(tasks[2]!.status).toBe("CANCELED");
  });
});

import { describe, it, expect } from "vitest";
import { detectCycle } from "../src/routing/dependency-resolver.js";
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

describe("detectCycle", () => {
  // ── Direct cycle ──────────────────────────────────────────────────────

  it("detects direct cycle A ↔ B", () => {
    const tasks = [
      makeTask("A", "PENDING", ["B"]),  // A depends on B
    ];

    // Adding B that depends on A creates a cycle
    const cycle = detectCycle(tasks, "B", ["A"]);
    expect(cycle).not.toBeNull();
    expect(cycle).toContain("A");
    expect(cycle).toContain("B");
  });

  // ── Transitive cycle ─────────────────────────────────────────────────

  it("detects transitive cycle A → B → C → A", () => {
    const tasks = [
      makeTask("A", "PENDING", ["C"]),  // A depends on C
      makeTask("B", "PENDING", ["A"]),  // B depends on A
    ];

    // Adding C that depends on B creates A → C → B → A cycle
    const cycle = detectCycle(tasks, "C", ["B"]);
    expect(cycle).not.toBeNull();
    expect(cycle!.length).toBeGreaterThanOrEqual(3);
    // The cycle should include all three nodes
    expect(cycle).toContain("A");
    expect(cycle).toContain("B");
    expect(cycle).toContain("C");
  });

  // ── Valid DAG ─────────────────────────────────────────────────────────

  it("returns null for valid DAG (no cycle)", () => {
    const tasks = [
      makeTask("A", "COMPLETED"),
      makeTask("B", "PENDING", ["A"]),
    ];

    // C depends on B — valid chain: A → B → C
    const cycle = detectCycle(tasks, "C", ["B"]);
    expect(cycle).toBeNull();
  });

  it("returns null for independent tasks", () => {
    const tasks = [
      makeTask("A", "PENDING"),
      makeTask("B", "PENDING"),
    ];

    // C depends on A — no cycle possible
    const cycle = detectCycle(tasks, "C", ["A"]);
    expect(cycle).toBeNull();
  });

  it("returns null for linear dependency chain", () => {
    const tasks = [
      makeTask("A", "COMPLETED"),
      makeTask("B", "PENDING", ["A"]),
      makeTask("C", "BLOCKED", ["B"]),
    ];

    // D depends on C — valid linear chain: A → B → C → D
    const cycle = detectCycle(tasks, "D", ["C"]);
    expect(cycle).toBeNull();
  });

  it("returns null for diamond dependency (no cycle)", () => {
    const tasks = [
      makeTask("A", "COMPLETED"),
      makeTask("B", "PENDING", ["A"]),
      makeTask("C", "PENDING", ["A"]),
    ];

    // D depends on both B and C — diamond shape, no cycle
    const cycle = detectCycle(tasks, "D", ["B", "C"]);
    expect(cycle).toBeNull();
  });

  // ── Self-referencing ─────────────────────────────────────────────────

  it("detects self-referencing dependency", () => {
    const tasks: TeamTask[] = [];

    // Task depends on itself
    const cycle = detectCycle(tasks, "A", ["A"]);
    expect(cycle).not.toBeNull();
    expect(cycle).toContain("A");
  });

  // ── Edge cases ────────────────────────────────────────────────────────

  it("returns null when new task has no dependencies", () => {
    const tasks = [
      makeTask("A", "PENDING"),
    ];

    const cycle = detectCycle(tasks, "B", []);
    expect(cycle).toBeNull();
  });

  it("returns null when tasks list is empty and no self-reference", () => {
    const cycle = detectCycle([], "A", ["B"]);
    expect(cycle).toBeNull();
  });

  it("detects cycle in longer chain (A → B → C → D → A)", () => {
    const tasks = [
      makeTask("A", "PENDING", ["D"]),  // A depends on D
      makeTask("B", "PENDING", ["A"]),  // B depends on A
      makeTask("C", "PENDING", ["B"]),  // C depends on B
    ];

    // Adding D that depends on C creates the full cycle
    const cycle = detectCycle(tasks, "D", ["C"]);
    expect(cycle).not.toBeNull();
    expect(cycle).toContain("A");
    expect(cycle).toContain("B");
    expect(cycle).toContain("C");
    expect(cycle).toContain("D");
  });
});

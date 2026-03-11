import { describe, it, expect } from "vitest";
import {
  buildOrchestratorContext,
  getOrchestratorMember,
} from "../src/patterns/orchestrator.js";
import { buildPeerContext, shouldAutoComplete } from "../src/patterns/peer.js";
import type { TeamConfig, TeamRun, TeamTask } from "../src/types.js";

// ── Shared fixtures ────────────────────────────────────────────────────

const orchConfig: TeamConfig = {
  description: "Orchestrator team",
  coordination: "orchestrator",
  orchestrator: "lead",
  members: {
    lead: { role: "Leader" },
    researcher: { role: "Researcher", skills: ["web-search"] },
    writer: { role: "Writer", skills: ["content-writing"] },
  },
};

const peerConfig: TeamConfig = {
  description: "Peer team",
  coordination: "peer",
  members: {
    alice: { role: "Dev", skills: ["frontend"] },
    bob: { role: "Dev", skills: ["backend"] },
  },
};

function makeRun(
  status: "WORKING" | "COMPLETED",
  tasks: Partial<TeamTask>[],
): TeamRun {
  const now = Date.now();
  return {
    id: "tr-test",
    team: "test",
    goal: "Test goal",
    status,
    tasks: tasks.map((t, i) => ({
      id: t.id ?? `t${i}`,
      team: "test",
      run_id: "tr-test",
      description: t.description ?? `Task ${i}`,
      status: t.status ?? "PENDING",
      assigned_to: t.assigned_to,
      created_at: now,
      updated_at: now,
    })),
    started_at: now,
    updated_at: now,
  };
}

// ── getOrchestratorMember ──────────────────────────────────────────────

describe("getOrchestratorMember", () => {
  it("returns orchestrator key", () => {
    expect(getOrchestratorMember(orchConfig)).toBe("lead");
  });

  it("throws if coordination is not 'orchestrator'", () => {
    expect(() => getOrchestratorMember(peerConfig)).toThrow(/not "orchestrator"/);
  });

  it("throws if orchestrator not in members", () => {
    const bad: TeamConfig = {
      description: "Bad",
      coordination: "orchestrator",
      orchestrator: "ghost",
      members: { alice: { role: "Dev" } },
    };
    expect(() => getOrchestratorMember(bad)).toThrow(/not listed in team members/);
  });
});

// ── buildOrchestratorContext ────────────────────────────────────────────

describe("buildOrchestratorContext", () => {
  it("includes orchestrator instructions", () => {
    const ctx = buildOrchestratorContext(orchConfig, null);
    expect(ctx).toContain("Orchestrator Instructions");
    expect(ctx).toContain("orchestrator");
  });

  it("includes team member directory", () => {
    const ctx = buildOrchestratorContext(orchConfig, null);
    expect(ctx).toContain("**lead**");
    expect(ctx).toContain("**researcher**");
    expect(ctx).toContain("**writer**");
    expect(ctx).toContain("web-search");
    expect(ctx).toContain("content-writing");
  });
});

// ── buildPeerContext ───────────────────────────────────────────────────

describe("buildPeerContext", () => {
  it("includes peer rules", () => {
    const ctx = buildPeerContext(peerConfig, "alice", null);
    expect(ctx).toContain("Peer Collaboration Mode");
    expect(ctx).toContain("Peer Rules");
    expect(ctx).toContain("**alice** (you)");
    expect(ctx).toContain("**bob**");
  });
});

// ── shouldAutoComplete ─────────────────────────────────────────────────

describe("shouldAutoComplete", () => {
  it("returns true when all tasks are terminal", () => {
    const run = makeRun("WORKING", [
      { status: "COMPLETED" },
      { status: "FAILED" },
      { status: "CANCELED" },
    ]);
    expect(shouldAutoComplete(run)).toBe(true);
  });

  it("returns false when tasks are still active", () => {
    const run = makeRun("WORKING", [
      { status: "COMPLETED" },
      { status: "WORKING" },
    ]);
    expect(shouldAutoComplete(run)).toBe(false);
  });

  it("returns false when run is already completed", () => {
    const run = makeRun("COMPLETED", [
      { status: "COMPLETED" },
    ]);
    expect(shouldAutoComplete(run)).toBe(false);
  });

  it("returns false when run has no tasks", () => {
    const run = makeRun("WORKING", []);
    expect(shouldAutoComplete(run)).toBe(false);
  });
});

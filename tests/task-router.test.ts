import { describe, it, expect } from "vitest";
import { routeTask } from "../src/routing/task-dispatcher.js";
import type { TeamConfig } from "../src/types.js";

const teamConfig: TeamConfig = {
  description: "Test team",
  coordination: "orchestrator",
  orchestrator: "lead",
  members: {
    lead: { role: "Leader" },
    researcher: { role: "Researcher", skills: ["web-search", "data-analysis"] },
    writer: { role: "Writer", skills: ["content-writing"] },
    analyst: { role: "Analyst", skills: ["data-analysis", "chart-generation"] },
  },
};

describe("routeTask", () => {
  // ── Direct assignment ────────────────────────────────────────────────

  it("assign_to overrides everything", () => {
    const result = routeTask(
      teamConfig,
      "Write a report",
      "writer",              // assignTo
      ["data-analysis"],     // requiredSkills (would match researcher)
    );
    expect(result.assigned_to).toBe("writer");
    expect(result.routing_reason).toBe("direct_assign");
  });

  // ── Skill matching ───────────────────────────────────────────────────

  it("exact skill match: required_skills=['web-search','data-analysis'] -> researcher", () => {
    const result = routeTask(
      teamConfig,
      "Research market data",
      undefined,
      ["web-search", "data-analysis"],
    );
    expect(result.assigned_to).toBe("researcher");
    expect(result.routing_reason).toBe("skill_exact_match");
  });

  it("best-fit match: required_skills=['data-analysis'] picks between researcher and analyst", () => {
    const result = routeTask(
      teamConfig,
      "Analyze data",
      undefined,
      ["data-analysis"],
    );
    // Both researcher and analyst have data-analysis — both are exact matches
    // With no existing tasks, load-balancer picks the first candidate
    expect(["researcher", "analyst"]).toContain(result.assigned_to);
    expect(result.routing_reason).toBe("skill_exact_match");
  });

  it("load balancing: when two members match, picks one with fewer active tasks", () => {
    const existingTasks = [
      { assigned_to: "researcher", status: "WORKING" },
      { assigned_to: "researcher", status: "PENDING" },
      { assigned_to: "analyst", status: "COMPLETED" }, // completed = not counted
    ];

    const result = routeTask(
      teamConfig,
      "Analyze data",
      undefined,
      ["data-analysis"],
      undefined,
      existingTasks,
    );
    // analyst has 0 active tasks, researcher has 2
    expect(result.assigned_to).toBe("analyst");
  });

  // ── Fallback ─────────────────────────────────────────────────────────

  it("fallback to orchestrator: no assign_to, no skills -> orchestrator", () => {
    const result = routeTask(teamConfig, "Coordinate something");
    expect(result.assigned_to).toBe("lead");
    expect(result.routing_reason).toBe("fallback_to_orchestrator");
  });

  it("peer fallback: coordination=peer, no assign_to -> caller", () => {
    const peerConfig: TeamConfig = {
      description: "Peer team",
      coordination: "peer",
      members: {
        alice: { role: "Dev" },
        bob: { role: "Dev" },
      },
    };

    const result = routeTask(
      peerConfig,
      "Fix a bug",
      undefined,
      undefined,
      "alice",
    );
    expect(result.assigned_to).toBe("alice");
    expect(result.routing_reason).toBe("peer_auto_assign");
  });

  it("peer fallback never assigns __leader__; it picks a real member instead", () => {
    const peerConfig: TeamConfig = {
      description: "Peer team",
      coordination: "peer",
      members: {
        alice: { role: "Dev" },
        bob: { role: "Dev" },
      },
    };

    const result = routeTask(
      peerConfig,
      "Seed the peer backlog",
      undefined,
      undefined,
      "__leader__",
      [{ assigned_to: "alice", status: "WORKING" }],
    );
    expect(result.assigned_to).toBe("bob");
    expect(result.routing_reason).toBe("peer_auto_assign");
  });

  it("no skills defined: falls through to fallback", () => {
    const noSkillsConfig: TeamConfig = {
      description: "No skills team",
      coordination: "orchestrator",
      orchestrator: "lead",
      members: {
        lead: { role: "Leader" },
        worker: { role: "Worker" }, // no skills array
      },
    };

    const result = routeTask(
      noSkillsConfig,
      "Do something",
      undefined,
      ["web-search"], // required skill, but nobody has skills defined
    );
    // Falls through skill matching to orchestrator fallback
    expect(result.assigned_to).toBe("lead");
    expect(result.routing_reason).toBe("fallback_to_orchestrator");
  });
});

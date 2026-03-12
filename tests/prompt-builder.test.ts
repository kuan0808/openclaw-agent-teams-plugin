import { describe, expect, it } from "vitest";

import { buildDecisionFlow } from "../src/cli/prompt-builder.js";
import type { TeamConfig } from "../src/types.js";

describe("buildDecisionFlow", () => {
  it("tells orchestrators to decompose into small, finishable tasks", () => {
    const config: TeamConfig = {
      description: "Orchestrator team",
      coordination: "orchestrator",
      orchestrator: "lead",
      members: {
        lead: { role: "Lead" },
        frontend: { role: "Frontend" },
        backend: { role: "Backend" },
      },
    };

    const prompt = buildDecisionFlow(config, "lead");

    expect(prompt).toContain("small, finishable tasks");
    expect(prompt).toContain("Avoid broad multi-part tasks");
    expect(prompt).toContain("If team_task(create) returns requires_session or REQUIRED_ACTION");
  });

  it("tells peers to finish their active work before creating more for themselves", () => {
    const config: TeamConfig = {
      description: "Peer team",
      coordination: "peer",
      members: {
        alice: { role: "Alice" },
        bob: { role: "Bob" },
      },
    };

    const prompt = buildDecisionFlow(config, "alice");

    expect(prompt).toContain("If you already have active tasks, continue them before creating more work for yourself");
    expect(prompt).toContain("Create tasks only for uncovered gaps");
  });
});

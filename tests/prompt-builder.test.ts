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

    expect(prompt).toContain("Keep tasks small and concrete");
    expect(prompt).toContain("REQUIRED_ACTION");
    expect(prompt).toContain("sessions_send");
  });

  it("orchestrator decision flow does NOT say activation is automatic", () => {
    const config: TeamConfig = {
      description: "Orchestrator team",
      coordination: "orchestrator",
      orchestrator: "lead",
      members: {
        lead: { role: "Lead" },
        frontend: { role: "Frontend" },
      },
    };

    const prompt = buildDecisionFlow(config, "lead");

    expect(prompt).not.toContain("Member activation is automatic");
    expect(prompt).not.toContain("You do NOT need to call sessions_send");
  });

  it("team member decision flow mentions REQUIRED_ACTION for unblocked members", () => {
    const config: TeamConfig = {
      description: "Orchestrator team",
      coordination: "orchestrator",
      orchestrator: "lead",
      members: {
        lead: { role: "Lead" },
        worker: { role: "Worker" },
      },
    };

    const prompt = buildDecisionFlow(config, "worker");

    expect(prompt).toContain("REQUIRED_ACTION");
    expect(prompt).toContain("activate members whose tasks were unblocked");
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

    expect(prompt).toContain("CHECK FIRST");
    expect(prompt).toContain("Do NOT create duplicate tasks");
  });
});

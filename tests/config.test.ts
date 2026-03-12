import { describe, expect, it } from "vitest";

import { validateConfig } from "../src/config.js";

describe("validateConfig", () => {
  it("rejects native members that remove core team tools", () => {
    const result = validateConfig({
      teams: {
        alpha: {
          description: "Team",
          coordination: "peer",
          members: {
            alice: {
              role: "Alice",
              tools: {
                allow: ["team_run", "team_memory", "team_send", "team_inbox"],
              },
            },
          },
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      'Team "alpha", member "alice": tools.allow must include "team_task" for Agent Teams to work',
    );
  });

  it("rejects native orchestrators that block sessions_spawn", () => {
    const result = validateConfig({
      teams: {
        alpha: {
          description: "Team",
          coordination: "orchestrator",
          orchestrator: "lead",
          members: {
            lead: {
              role: "Lead",
              tools: {
                deny: ["sessions_spawn"],
              },
            },
            worker: {
              role: "Worker",
            },
          },
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      'Team "alpha", member "lead": native orchestrators must not deny "sessions_spawn"',
    );
  });

  it("allows CLI members to define tool restrictions without native-tool validation", () => {
    const result = validateConfig({
      teams: {
        alpha: {
          description: "Team",
          coordination: "peer",
          members: {
            reviewer: {
              role: "Reviewer",
              cli: "codex",
              tools: {
                allow: ["some_cli_tool_only"],
              },
            },
          },
        },
      },
    });

    expect(result.ok).toBe(true);
  });
});

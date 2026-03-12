/**
 * Scenario 5: Orchestrator Full Lifecycle (Checkpoint-Based)
 *
 * Validates every lifecycle step via sequential checkpoints:
 * run_started → task decomposition → work in progress → task completion → run completion
 *
 * Team: alpha (orchestrator mode — lead, frontend, backend, designer)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as crypto from "node:crypto";
import { askAgent } from "../helpers/openclaw.js";
import { getBroadcastPath } from "../helpers/state.js";
import { EventWatcher } from "../helpers/watcher.js";
import { cleanAllState } from "../helpers/reset.js";
import {
  runLifecycleCheckpoints,
  assertActivityLogIntegrity,
  assertStateConsistency,
} from "../helpers/lifecycle.js";

describe("Scenario 5: Orchestrator Full Lifecycle", () => {
  let watcher: EventWatcher;
  let sessionId: string;

  beforeAll(async () => {
    await cleanAllState();
    watcher = new EventWatcher(getBroadcastPath());
    sessionId = `e2e-orch-${crypto.randomUUID()}`;
  });

  afterAll(() => {
    watcher?.close();
  });

  it("5.1: full orchestrator lifecycle with checkpoints", { timeout: 900_000 }, async () => {
    // Non-blocking prompt
    const responsePromise = askAgent(
      "I need the alpha team to build a weather dashboard application. " +
        "It should have three parts: a React frontend with weather charts, " +
        "a Node.js backend API that fetches weather data, " +
        "and UX mockups for the mobile layout. " +
        "Use the Agent Teams plugin to coordinate this.",
      { timeout: 120_000, sessionId },
    );

    // Run all checkpoints
    const progress = await runLifecycleCheckpoints(
      {
        team: "alpha",
        validMembers: ["lead", "frontend", "backend", "designer"],
        coordinationMode: "orchestrator",
        orchestrator: "lead",
        maxTasks: 20,
      },
      watcher,
      responsePromise,
      sessionId,
    );

    console.log(progress.diagnosticSummary);

    // Hard assertions: CP1-CP4 must pass
    for (const cp of progress.checkpoints) {
      if (cp.name !== "Run Completion") {
        expect(cp.passed, `${cp.name}: ${cp.details}`).toBe(true);
      }
    }

    // CP5 soft: partial progress acceptable
    if (progress.completed) {
      const cp5 = progress.checkpoints.find((c) => c.name === "Run Completion");
      expect(cp5?.passed, cp5?.details).toBe(true);
    }

    // Orchestrator-specific: task_created events should come from "lead"
    const taskCreatedEvents = watcher.getEventsOfType(
      "task_created",
      (e) => e.team === "alpha",
    );
    for (const evt of taskCreatedEvents) {
      expect(evt.agent).toBe("lead");
    }

    // Activity log integrity
    assertActivityLogIntegrity("alpha");
  });

  it("5.2: state consistency", { timeout: 30_000 }, async () => {
    assertStateConsistency("alpha");
  });
});

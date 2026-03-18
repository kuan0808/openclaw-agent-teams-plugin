/**
 * Scenario 7: CLI Orchestrator — Native Lead + CLI Workers
 *
 * Team: gamma (orchestrator mode — native lead, CLI coder, CLI tester)
 * Validates CLI agent spawning, MCP bridge communication, and full lifecycle.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as crypto from "node:crypto";
import { askAgent } from "../helpers/openclaw.js";
import { getBroadcastPath, findSystemNotifications } from "../helpers/state.js";
import { EventWatcher } from "../helpers/watcher.js";
import { cleanAllState } from "../helpers/reset.js";
import {
  runLifecycleCheckpoints,
  assertActivityLogIntegrity,
  assertStateConsistency,
  assertRequesterNotifications,
} from "../helpers/lifecycle.js";
import { assertCliAgentLogs, assertNoCrashes } from "../helpers/cli-assertions.js";

describe("Scenario 7: CLI Orchestrator — Native Lead + CLI Workers", () => {
  let watcher: EventWatcher;
  let sessionId: string;

  beforeAll(async () => {
    await cleanAllState();
    watcher = new EventWatcher(getBroadcastPath());
    sessionId = `e2e-cli-orch-${crypto.randomUUID()}`;
  });

  afterAll(() => {
    watcher?.close();
  });

  it("7.1: full lifecycle with native lead + CLI workers", { timeout: 1_500_000 }, async () => {
    const responsePromise = askAgent(
      "I need the gamma team to build a URL shortener service. " +
        "It should have a Node.js API with endpoints to create and resolve short URLs, " +
        "plus comprehensive unit tests with good coverage. " +
        "Use the Agent Teams plugin to coordinate this.",
      { timeout: 120_000, sessionId },
    );

    const progress = await runLifecycleCheckpoints(
      {
        team: "gamma",
        validMembers: ["lead", "coder", "tester"],
        coordinationMode: "orchestrator",
        orchestrator: "lead",
        maxTasks: 10,
        timeouts: {
          workInProgress: 480_000,
          taskCompletion: 720_000,
          runCompletion: 300_000,
          safetyNet: 120_000,
        },
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
      (e) => e.team === "gamma",
    );
    for (const evt of taskCreatedEvents) {
      expect(evt.agent).toBe("lead");
    }

    // CLI-specific assertions
    assertCliAgentLogs("gamma", ["coder", "tester"]);
    assertNoCrashes("gamma");

    // Activity log integrity
    assertActivityLogIntegrity("gamma");

    // Log transcript notifications (informational — transcripts may be cleaned between scenarios)
    const sysNotifications = findSystemNotifications(sessionId, "gamma");
    console.log(`Transcript notifications for gamma: ${sysNotifications.length}`);

    // Requester notification assertions
    assertRequesterNotifications("gamma", {
      taskProgress: true,
      runCompleted: progress.completed ? true : undefined,
      autoCompleted: progress.completed ? true : undefined,
    });
  });

  it("7.2: state consistency", { timeout: 30_000 }, async () => {
    assertStateConsistency("gamma");
  });
});

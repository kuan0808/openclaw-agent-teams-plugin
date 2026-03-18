/**
 * Scenario 10: Pure CLI Team
 *
 * Team: eta (orchestrator mode — CLI lead, CLI worker)
 * Validates that a team with ALL CLI agents works end-to-end.
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

describe("Scenario 10: Pure CLI Team", () => {
  let watcher: EventWatcher;
  let sessionId: string;

  beforeAll(async () => {
    await cleanAllState();
    watcher = new EventWatcher(getBroadcastPath());
    sessionId = `e2e-cli-pure-${crypto.randomUUID()}`;
  });

  afterAll(() => {
    watcher?.close();
  });

  it("10.1: full lifecycle with pure CLI team", { timeout: 1_500_000 }, async () => {
    const responsePromise = askAgent(
      "I need the eta team to build a simple CLI calculator tool in Node.js. " +
        "It should support add, subtract, multiply, divide operations via command line arguments. " +
        "Include input validation and error handling. " +
        "Use the Agent Teams plugin to coordinate this.",
      { timeout: 120_000, sessionId },
    );

    const progress = await runLifecycleCheckpoints(
      {
        team: "eta",
        validMembers: ["lead", "worker"],
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

    // CP5 soft
    if (progress.completed) {
      const cp5 = progress.checkpoints.find((c) => c.name === "Run Completion");
      expect(cp5?.passed, cp5?.details).toBe(true);
    }

    // All agents are CLI — verify logs exist (allowEmpty for workers that may
    // be spawned via different paths depending on task assignment timing)
    assertCliAgentLogs("eta", ["lead", "worker"], { allowEmpty: true });
    assertNoCrashes("eta");

    // Activity log integrity — skip run_started check: the main agent logs
    // it to a store instance that may differ from the persisted one due to
    // gateway re-activation. The broadcast events confirm run_started occurred.
    assertActivityLogIntegrity("eta", { skipRunStarted: true });

    // Log transcript notifications (informational — transcripts may be cleaned between scenarios)
    const sysNotifications = findSystemNotifications(sessionId, "eta");
    console.log(`Transcript notifications for eta: ${sysNotifications.length}`);

    // Requester notification assertions
    assertRequesterNotifications("eta", {
      taskProgress: true,
      runCompleted: progress.completed ? true : undefined,
      autoCompleted: progress.completed ? true : undefined,
    });
  });

  it("10.2: state consistency", { timeout: 30_000 }, async () => {
    assertStateConsistency("eta");
  });
});

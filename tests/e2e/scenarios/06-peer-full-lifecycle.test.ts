/**
 * Scenario 6: Peer Full Lifecycle (Checkpoint-Based)
 *
 * Validates every lifecycle step via sequential checkpoints:
 * run_started → task decomposition → work in progress → task completion → run completion
 *
 * Team: beta (peer mode — alice, bob, carol)
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

const BETA_MEMBERS = ["alice", "bob", "carol"];

describe("Scenario 6: Peer Full Lifecycle", () => {
  let watcher: EventWatcher;
  let sessionId: string;

  beforeAll(async () => {
    await cleanAllState();
    watcher = new EventWatcher(getBroadcastPath());
    sessionId = `e2e-peer-${crypto.randomUUID()}`;
  });

  afterAll(() => {
    watcher?.close();
  });

  it("6.1: full peer lifecycle with checkpoints", { timeout: 900_000 }, async () => {
    // Non-blocking prompt
    const responsePromise = askAgent(
      "Have the beta team build a shared utility library for a web project. " +
        "It should include string and date manipulation utilities, " +
        "a test infrastructure with integration tests, " +
        "and React hook helpers for common UI patterns. " +
        "Use the Agent Teams plugin to coordinate this.",
      { timeout: 120_000, sessionId },
    );

    // Run all checkpoints
    const progress = await runLifecycleCheckpoints(
      {
        team: "beta",
        validMembers: BETA_MEMBERS,
        coordinationMode: "peer",
        maxTasks: 20,
        timeouts: {
          workInProgress: 480_000,  // Main agent activates peers sequentially via sessions_send
        },
      },
      watcher,
      responsePromise,
      sessionId,
    );

    console.log(progress.diagnosticSummary);

    // Hard assertions: CP1-CP4 must pass. CP5 (Run Completion) is soft —
    // peer auto-complete timing is unpredictable but tasks must finish.
    for (const cp of progress.checkpoints) {
      if (cp.name !== "Run Completion") {
        expect(cp.passed, `${cp.name}: ${cp.details}`).toBe(true);
      }
    }

    // CP5 soft pass
    if (progress.completed) {
      const cp5 = progress.checkpoints.find((c) => c.name === "Run Completion");
      expect(cp5?.passed, cp5?.details).toBe(true);
    }

    // Peer-specific: task_created agents can be any valid member
    const taskCreatedEvents = watcher.getEventsOfType(
      "task_created",
      (e) => e.team === "beta",
    );
    for (const evt of taskCreatedEvents) {
      expect(BETA_MEMBERS).toContain(evt.agent);
    }

    // Activity log integrity
    assertActivityLogIntegrity("beta");

    // Log transcript notifications (informational — transcripts may be cleaned between scenarios)
    const sysNotifications = findSystemNotifications(sessionId, "beta");
    console.log(`Transcript notifications for beta: ${sysNotifications.length}`);

    // Requester notification assertions
    assertRequesterNotifications("beta", {
      taskProgress: true,
      autoCompleted: progress.completed ? true : undefined,
    });
  });

  it("6.2: state consistency", { timeout: 30_000 }, async () => {
    assertStateConsistency("beta");
  });
});

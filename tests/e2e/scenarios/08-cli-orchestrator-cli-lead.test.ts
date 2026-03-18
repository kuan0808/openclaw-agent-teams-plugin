/**
 * Scenario 8: CLI Orchestrator — CLI Lead + Native Workers
 *
 * Team: epsilon (orchestrator mode — CLI lead, native frontend, native backend)
 * Validates CLI agent as orchestrator, creating tasks via MCP bridge.
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

describe("Scenario 8: CLI Orchestrator — CLI Lead + Native Workers", () => {
  let watcher: EventWatcher;
  let sessionId: string;

  beforeAll(async () => {
    await cleanAllState();
    watcher = new EventWatcher(getBroadcastPath());
    sessionId = `e2e-cli-lead-${crypto.randomUUID()}`;
  });

  afterAll(() => {
    watcher?.close();
  });

  it("8.1: full lifecycle with CLI lead + native workers", { timeout: 1_500_000 }, async () => {
    const responsePromise = askAgent(
      "I need the epsilon team to build a todo list application. " +
        "It should have a React frontend with add/edit/delete functionality, " +
        "and a Node.js REST API backend with in-memory storage. " +
        "Use the Agent Teams plugin to coordinate this.",
      { timeout: 120_000, sessionId },
    );

    const progress = await runLifecycleCheckpoints(
      {
        team: "epsilon",
        validMembers: ["lead", "frontend", "backend"],
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

    // CLI lead should create tasks (via MCP bridge)
    const taskCreatedEvents = watcher.getEventsOfType(
      "task_created",
      (e) => e.team === "epsilon",
    );
    for (const evt of taskCreatedEvents) {
      expect(evt.agent).toBe("lead");
    }

    // CLI-specific assertions
    // Note: CLI orchestrator (lead) is activated via sessions_send, not PTY spawn.
    // Only workers assigned tasks via team_task(create) get PTY spawned.
    // No CLI log assertion for orchestrator — it runs as a native subagent.
    assertNoCrashes("epsilon");

    // Activity log integrity
    assertActivityLogIntegrity("epsilon");

    // Log transcript notifications (informational — transcripts may be cleaned between scenarios)
    const sysNotifications = findSystemNotifications(sessionId, "epsilon");
    console.log(`Transcript notifications for epsilon: ${sysNotifications.length}`);

    // Requester notification assertions
    assertRequesterNotifications("epsilon", {
      taskProgress: true,
      runCompleted: progress.completed ? true : undefined,
      autoCompleted: progress.completed ? true : undefined,
    });
  });

  it("8.2: state consistency", { timeout: 30_000 }, async () => {
    assertStateConsistency("epsilon");
  });
});

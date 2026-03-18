/**
 * Scenario 11: Large CLI Team (4 members)
 *
 * Team: theta (orchestrator mode — CLI pm + 3 CLI specialists)
 * Validates that a larger all-CLI team can decompose a complex task
 * into multiple subtasks assigned to different specialists.
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

describe("Scenario 11: Large CLI Team", () => {
  let watcher: EventWatcher;
  let sessionId: string;

  beforeAll(async () => {
    await cleanAllState();
    watcher = new EventWatcher(getBroadcastPath());
    sessionId = `e2e-cli-large-${crypto.randomUUID()}`;
  });

  afterAll(() => {
    watcher?.close();
  });

  it("11.1: complex task with multiple specialists", { timeout: 1_500_000 }, async () => {
    const responsePromise = askAgent(
      "I need the theta team to build a simple web-based todo app. " +
        "Requirements:\n" +
        "- Frontend: An index.html file with a form to add todos, a list to display them, " +
        "and buttons to mark complete/delete. Use vanilla HTML/CSS/JS.\n" +
        "- Backend: A server.js file using Node.js http module (no external deps) " +
        "that serves the HTML and provides a REST API (GET/POST/DELETE /api/todos) " +
        "with in-memory storage.\n" +
        "- Testing: A test.js file that uses Node's built-in test runner to verify " +
        "the API endpoints work correctly.\n" +
        "Assign different parts to the appropriate specialists (frontend, backend, tester). " +
        "Use the Agent Teams plugin to coordinate this.",
      { timeout: 120_000, sessionId },
    );

    const progress = await runLifecycleCheckpoints(
      {
        team: "theta",
        validMembers: ["pm", "frontend", "backend", "tester"],
        coordinationMode: "orchestrator",
        orchestrator: "pm",
        maxTasks: 15,
        timeouts: {
          workInProgress: 600_000,
          taskCompletion: 900_000,
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

    // Verify CLI agent logs exist for all members
    assertCliAgentLogs("theta", ["pm", "frontend", "backend", "tester"], { allowEmpty: true });
    assertNoCrashes("theta");

    // Activity log integrity
    assertActivityLogIntegrity("theta", { skipRunStarted: true });

    // Verify multiple tasks were created (the whole point of this test)
    const taskCreatedEvents = progress.allEvents.filter(
      (e) => e.type === "task_created" && e.team === "theta",
    );
    console.log(`Tasks created: ${taskCreatedEvents.length}`);
    expect(taskCreatedEvents.length).toBeGreaterThanOrEqual(2);

    // Log transcript notifications (informational — transcripts may be cleaned between scenarios)
    const sysNotifications = findSystemNotifications(sessionId, "theta");
    console.log(`Transcript notifications for theta: ${sysNotifications.length}`);

    // Requester notification assertions
    assertRequesterNotifications("theta", {
      taskProgress: true,
      runCompleted: progress.completed ? true : undefined,
      autoCompleted: progress.completed ? true : undefined,
    });
  });

  it("11.2: state consistency", { timeout: 30_000 }, async () => {
    assertStateConsistency("theta");
  });
});

/**
 * Scenario 9: CLI Peer — Mixed Native + CLI
 *
 * Team: zeta (peer mode — native dev1, CLI dev2)
 * Validates mixed peer collaboration between native and CLI agents.
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

const ZETA_MEMBERS = ["dev1", "dev2"];

describe("Scenario 9: CLI Peer — Mixed Native + CLI", () => {
  let watcher: EventWatcher;
  let sessionId: string;

  beforeAll(async () => {
    await cleanAllState();
    watcher = new EventWatcher(getBroadcastPath());
    sessionId = `e2e-cli-peer-${crypto.randomUUID()}`;
  });

  afterAll(() => {
    watcher?.close();
  });

  it("9.1: full peer lifecycle with mixed native + CLI", { timeout: 1_500_000 }, async () => {
    const responsePromise = askAgent(
      "Have the zeta team build a markdown-to-HTML converter library. " +
        "It should parse common markdown syntax (headings, bold, italic, links, code blocks) " +
        "and include unit tests. " +
        "Use the Agent Teams plugin to coordinate this.",
      { timeout: 120_000, sessionId },
    );

    const progress = await runLifecycleCheckpoints(
      {
        team: "zeta",
        validMembers: ZETA_MEMBERS,
        coordinationMode: "peer",
        maxTasks: 10,
        timeouts: {
          workInProgress: 480_000,
          taskCompletion: 720_000,
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

    // Peer-specific: task_created agents must be valid members
    const taskCreatedEvents = watcher.getEventsOfType(
      "task_created",
      (e) => e.team === "zeta",
    );
    for (const evt of taskCreatedEvents) {
      expect(ZETA_MEMBERS).toContain(evt.agent);
    }

    // CLI-specific assertions
    // In peer mode, CLI members may be activated via sessions_send (native path)
    // rather than PTY spawn, so log files may be empty.
    assertCliAgentLogs("zeta", ["dev2"], { allowEmpty: true });
    assertNoCrashes("zeta");

    // Activity log integrity
    assertActivityLogIntegrity("zeta");

    // Log transcript notifications (informational — transcripts may be cleaned between scenarios)
    const sysNotifications = findSystemNotifications(sessionId, "zeta");
    console.log(`Transcript notifications for zeta: ${sysNotifications.length}`);

    // Requester notification assertions
    assertRequesterNotifications("zeta", {
      taskProgress: true,
      autoCompleted: progress.completed ? true : undefined,
    });
  });

  it("9.2: state consistency", { timeout: 30_000 }, async () => {
    assertStateConsistency("zeta");
  });
});

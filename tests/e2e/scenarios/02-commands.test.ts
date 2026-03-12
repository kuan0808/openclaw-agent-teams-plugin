/**
 * Scenario 2: Commands
 *
 * Tests the /team commands (/team list, /team status, /team stop).
 * Simplest scenario — no subagent work, verifies basic plugin activation.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { askAgent } from "../helpers/openclaw.js";
import {
  readRunState,
  readActivity,
  readBroadcast,
  getBroadcastPath,
} from "../helpers/state.js";
import { EventWatcher } from "../helpers/watcher.js";
import { cleanAllState } from "../helpers/reset.js";

describe("Scenario 2: Commands", () => {
  beforeAll(async () => {
    await cleanAllState();
  });

  it("2.1: /team list shows configured teams", async () => {
    const response = await askAgent(
      "Show me all configured teams using /team list",
      { timeout: 60_000 },
    );

    // Response should be meaningful
    expect(response.payloads).toBeDefined();
    expect(response.payloads!.length).toBeGreaterThan(0);

    // Combine all payload texts for matching
    const allText = response.payloads!
      .map((p) => p.text ?? "")
      .join(" ")
      .toLowerCase();
    expect(allText.length).toBeGreaterThan(0);

    // Should mention at least some team names or the word "team"
    const mentionsTeam =
      allText.includes("alpha") ||
      allText.includes("beta") ||
      allText.includes("delta") ||
      allText.includes("team");
    expect(mentionsTeam).toBe(true);

    // No error
    expect(response.meta.error).toBeUndefined();
    expect(response.meta.stopReason).toBe("stop");
  });

  it("2.2: /team status shows run info after starting a run", async () => {
    // First, start a run on alpha so there's status to show
    const watcher = new EventWatcher(getBroadcastPath());
    try {
      const startPromise = askAgent(
        "I need the alpha team to build a simple hello world app. " +
          "Use the Agent Teams plugin to coordinate this.",
        { timeout: 120_000 },
      );

      // Wait for the run to start
      await watcher.expectEvent("run_started", {
        timeout: 60_000,
        match: (e) => e.team === "alpha",
      });

      // Wait for main agent response
      await startPromise;

      // Now check status
      const statusResponse = await askAgent(
        "Show me the status of the alpha team using /team status alpha",
        { timeout: 60_000 },
      );

      expect(statusResponse.payloads).toBeDefined();
      expect(statusResponse.payloads!.length).toBeGreaterThan(0);

      const text = statusResponse.payloads![0].text ?? "";
      expect(text.length).toBeGreaterThan(0);

      // Should mention the run status or tasks
      const lowerText = text.toLowerCase();
      const mentionsStatus =
        lowerText.includes("working") ||
        lowerText.includes("completed") ||
        lowerText.includes("task") ||
        lowerText.includes("run") ||
        lowerText.includes("alpha");
      expect(mentionsStatus).toBe(true);

      expect(statusResponse.meta.error).toBeUndefined();
    } finally {
      watcher.close();
    }
  });

  it("2.3: /team stop cancels an active run", async () => {
    // Ensure there's an active run (may already exist from 2.2, or start one)
    const runState = readRunState("alpha");
    if (!runState || runState.status !== "WORKING") {
      const watcher = new EventWatcher(getBroadcastPath());
      try {
        const startPromise = askAgent(
          "Have the alpha team build a simple calculator app. " +
            "Use the Agent Teams plugin to coordinate this.",
          { timeout: 120_000 },
        );
        await watcher.expectEvent("run_started", {
          timeout: 60_000,
          match: (e) => e.team === "alpha",
        });
        await startPromise;
      } finally {
        watcher.close();
      }
    }

    // Now stop the run
    const stopResponse = await askAgent(
      "Stop the current run for the alpha team using /team stop alpha",
      { timeout: 60_000 },
    );

    expect(stopResponse.meta.error).toBeUndefined();

    // Verify state file
    const finalState = readRunState("alpha");
    expect(finalState).not.toBeNull();
    expect(finalState!.status).toBe("CANCELED");
    expect(finalState!.cancel_reason).toBeDefined();

    // Verify activity log
    const activity = readActivity("alpha");
    const cancelEntries = activity.filter((e) => e.type === "run_canceled");
    expect(cancelEntries.length).toBeGreaterThan(0);

    // Verify broadcast
    const broadcast = readBroadcast();
    const cancelEvents = broadcast.filter(
      (e) => e.type === "run_canceled" && e.team === "alpha",
    );
    expect(cancelEvents.length).toBeGreaterThan(0);
  });
});

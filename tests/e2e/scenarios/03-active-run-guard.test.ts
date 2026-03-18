/**
 * Scenario 3: Active Run Guard
 *
 * Tests that only one run can be active per team at a time.
 * Starting a new project while one is already in progress should
 * be rejected until the first is completed or canceled.
 *
 * Prompts are from the user's perspective — describe WHAT, not HOW.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { askAgent } from "../helpers/openclaw.js";
import { readRunState, readActivity, getBroadcastPath } from "../helpers/state.js";
import { EventWatcher } from "../helpers/watcher.js";
import { cleanAllState } from "../helpers/reset.js";

describe("Scenario 3: Active Run Guard", () => {
  beforeAll(async () => {
    await cleanAllState();
  });

  it("3.1: cannot start overlapping runs on same team", async () => {
    const watcher = new EventWatcher(getBroadcastPath());

    try {
      // Step 1: Start a project
      const startPromise = askAgent(
        "Have the alpha team build an authentication system. " +
          "Use the Agent Teams plugin to coordinate this.",
        { timeout: 120_000 },
      );

      await watcher.expectEvent("run_started", {
        timeout: 60_000,
        match: (e) => e.team === "alpha",
      });

      await startPromise;

      // Verify run is WORKING
      const runState = readRunState("alpha");
      expect(runState).not.toBeNull();
      expect(runState!.status).toBe("WORKING");

      // Step 2: Try to start another project on the same team (should be rejected)
      const secondResponse = await askAgent(
        "Start a fresh project for the alpha team to build a payment system. " +
          "Use the Agent Teams plugin to coordinate this.",
        { timeout: 120_000 },
      );

      // The original run should still be active — second start was rejected
      const afterState = readRunState("alpha");
      expect(afterState).not.toBeNull();
      expect(afterState!.status).toBe("WORKING");

      // The agent should not have errored fatally
      expect(secondResponse.meta.error).toBeUndefined();

      // Step 3: Cancel the current project
      await askAgent(
        "Stop the alpha team's current work because we're switching priorities.",
        { timeout: 120_000 },
      );

      const canceledState = readRunState("alpha");
      expect(canceledState).not.toBeNull();
      expect(canceledState!.status).toBe("CANCELED");

      // Verify cancel is recorded in the activity log
      const activityAfterCancel = readActivity("alpha");
      const cancelTypes = activityAfterCancel.map((e) => e.type);
      expect(cancelTypes).toContain("run_canceled");

      // Step 4: Now start a new project (should succeed)
      const freshPromise = askAgent(
        "Start a fresh project for the alpha team to build a payment system. " +
          "Use the Agent Teams plugin to coordinate this.",
        { timeout: 120_000 },
      );

      await watcher.expectEvent("run_started", {
        timeout: 60_000,
        match: (e) => e.team === "alpha",
      });

      await freshPromise;

      const freshState = readRunState("alpha");
      expect(freshState).not.toBeNull();
      expect(freshState!.status).toBe("WORKING");
      expect(freshState!.goal.toLowerCase()).toContain("payment");

      // Final activity log must contain two run_started entries (original + fresh)
      const finalActivity = readActivity("alpha");
      const runStartedEntries = finalActivity.filter(
        (e) => e.type === "run_started",
      );
      expect(runStartedEntries.length).toBeGreaterThanOrEqual(2);
    } finally {
      watcher.close();
    }
  });

  it("3.2: guard state preserved across separate agent calls", async () => {
    // After 3.1, the fresh run from step 4 should still be WORKING
    const runState = readRunState("alpha");
    expect(runState).not.toBeNull();
    expect(runState!.status).toBe("WORKING");

    // Try to start another project in a separate session
    const response = await askAgent(
      "Have the alpha team build a CMS system. " +
        "Let me know if there's a conflict with existing work.",
      { timeout: 120_000 },
    );

    // State should not have changed — still the same run from 6.1 step 4
    const stateAfter = readRunState("alpha");
    expect(stateAfter).not.toBeNull();
    expect(stateAfter!.status).toBe("WORKING");

    // The agent should acknowledge the conflict in its reply
    const allText = (response.payloads ?? [])
      .map((p) => p.text ?? "")
      .join(" ")
      .toLowerCase();

    const mentionsConflict =
      allText.includes("already") ||
      allText.includes("active") ||
      allText.includes("working") ||
      allText.includes("cancel") ||
      allText.includes("exist") ||
      allText.includes("error") ||
      allText.includes("current");
    expect(mentionsConflict).toBe(true);

    expect(response.meta.error).toBeUndefined();
  });
});

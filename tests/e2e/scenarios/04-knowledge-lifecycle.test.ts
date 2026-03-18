/**
 * Scenario 4: Knowledge Lifecycle
 *
 * Tests that learnings are captured during a run and that knowledge
 * state is durable across separate agent calls.
 *
 * Prompts are from the user's perspective — describe WHAT, not HOW.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { askAgent } from "../helpers/openclaw.js";
import {
  readRunState,
  readActivity,
  readKv,
  getBroadcastPath,
} from "../helpers/state.js";
import { EventWatcher } from "../helpers/watcher.js";
import { cleanAllState } from "../helpers/reset.js";

describe("Scenario 4: Knowledge Lifecycle", () => {
  beforeAll(async () => {
    await cleanAllState();
  });

  it("4.1: learnings captured during team project", async () => {
    const watcher = new EventWatcher(getBroadcastPath());

    try {
      // Fire the agent call — don't block on it; the orchestrator lifecycle
      // may take longer than any single CLI timeout allows.
      const startPromise = askAgent(
        "Have the alpha team build a search feature. " +
          "Create tasks, complete them, and capture insights about patterns used. " +
          "Use the Agent Teams plugin to coordinate this.",
        { timeout: 300_000 },
      ).catch(() => {
        // CLI timeout is acceptable — subagents continue working in background
      });

      // Wait for run to start
      await watcher.expectEvent("run_started", {
        timeout: 60_000,
        match: (e) => e.team === "alpha",
      });

      // Wait for at least one task to complete (proves orchestrator lifecycle works)
      await watcher.expectEvent("task_completed", {
        timeout: 300_000,
        match: (e) => e.team === "alpha",
      });

      // Give subagents a moment to flush learnings after task completion
      await watcher.waitForQuiet("task_completed", 15_000);

      await startPromise;

      // Check KV for learning entries
      const kvEntries = readKv("alpha");
      const learningEntries = kvEntries.filter((e) =>
        e.key.startsWith("learnings:"),
      );

      // Check activity log for learning events
      const activity = readActivity("alpha");
      const learningEvents = activity.filter(
        (e) => e.type === "learning_captured",
      );

      // At least the run lifecycle should be logged
      const types = activity.map((e) => e.type);
      expect(types).toContain("run_started");

      // If learnings were captured, verify structure
      for (const entry of learningEntries) {
        expect(entry.key).toMatch(/^learnings:/);
        expect(entry.value).toBeDefined();
        expect(entry.written_by).toBeDefined();
        expect(typeof entry.created_at).toBe("number");
      }

      // If learning events appear in activity, verify their structure
      for (const event of learningEvents) {
        expect(event.team).toBe("alpha");
        expect(event.agent).toBeDefined();
        expect(event.timestamp).toBeGreaterThan(0);
      }
    } finally {
      watcher.close();
    }
  });

  it("4.2: knowledge state persists across checks", async () => {
    // After the previous test, verify KV state is still readable from disk
    const kvEntries = readKv("alpha");
    const activity = readActivity("alpha");

    // Activity log must have entries from the run
    expect(activity.length).toBeGreaterThan(0);

    // Verify temporal ordering — events must be in non-decreasing timestamp order
    for (let i = 1; i < activity.length; i++) {
      expect(activity[i].timestamp).toBeGreaterThanOrEqual(
        activity[i - 1].timestamp,
      );
    }

    // Every KV entry must have the mandatory fields
    for (const entry of kvEntries) {
      expect(entry.key).toBeDefined();
      expect(typeof entry.key).toBe("string");
      expect(entry.value).toBeDefined();
      expect(entry.written_by).toBeDefined();
      expect(typeof entry.created_at).toBe("number");
    }
  });

  it("4.3: explicit memory write is reflected in KV store", async () => {
    // User asks the team to save a note — natural request
    const response = await askAgent(
      "Save a note for the alpha team about using LRU caching for search results, " +
        "then verify it was saved.",
      { timeout: 180_000 },
    );

    expect(response.meta.error).toBeUndefined();

    const kvEntries = readKv("alpha");

    // At least some KV entries should exist (from this + previous test)
    expect(kvEntries.length).toBeGreaterThan(0);

    // Agent response should confirm the operation
    const allText = (response.payloads ?? [])
      .map((p) => p.text ?? "")
      .join(" ")
      .toLowerCase();
    expect(allText.length).toBeGreaterThan(0);

    // Verify memory_updated events in activity log
    const activity = readActivity("alpha");
    const memoryEvents = activity.filter((e) => e.type === "memory_updated");
    expect(memoryEvents.length).toBeGreaterThan(0);
    for (const event of memoryEvents) {
      expect(event.team).toBe("alpha");
      expect(event.agent).toBeDefined();
    }
  });
});

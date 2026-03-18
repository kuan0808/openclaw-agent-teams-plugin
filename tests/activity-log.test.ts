import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { ActivityLog } from "../src/state/activity-log.js";

const tmpDir = path.join(os.tmpdir(), "at-test-activity-" + Math.random().toString(36).slice(2));

describe("ActivityLog", () => {
  let log: ActivityLog;

  beforeEach(async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    log = new ActivityLog(path.join(tmpDir, "activity"));
    await log.load();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ── Basic logging ─────────────────────────────────────────────────

  it("should log an activity entry", () => {
    const entry = log.log("dev", "alice", "task_created", "Task created: do stuff", {
      target_id: "task-1",
      metadata: { assigned_to: "bob" },
    });

    expect(entry.id).toBe("act-0");
    expect(entry.team).toBe("dev");
    expect(entry.agent).toBe("alice");
    expect(entry.type).toBe("task_created");
    expect(entry.description).toBe("Task created: do stuff");
    expect(entry.target_id).toBe("task-1");
    expect(entry.metadata).toEqual({ assigned_to: "bob" });
    expect(entry.timestamp).toBeGreaterThan(0);
  });

  it("should auto-increment IDs", () => {
    const e1 = log.log("dev", "alice", "task_created", "First");
    const e2 = log.log("dev", "bob", "task_updated", "Second");
    const e3 = log.log("dev", "alice", "task_completed", "Third");

    expect(e1.id).toBe("act-0");
    expect(e2.id).toBe("act-1");
    expect(e3.id).toBe("act-2");
  });

  it("should track total entry count", () => {
    expect(log.size).toBe(0);
    log.log("dev", "alice", "task_created", "One");
    log.log("dev", "bob", "task_updated", "Two");
    expect(log.size).toBe(2);
  });

  // ── Query ─────────────────────────────────────────────────────────

  it("should query by type", () => {
    log.log("dev", "alice", "task_created", "Created 1");
    log.log("dev", "alice", "task_updated", "Updated 1");
    log.log("dev", "bob", "task_created", "Created 2");

    const created = log.query({ type: "task_created" });
    expect(created).toHaveLength(2);
  });

  it("should query by agent", () => {
    log.log("dev", "alice", "task_created", "A1");
    log.log("dev", "bob", "task_created", "B1");
    log.log("dev", "alice", "task_updated", "A2");

    const aliceEntries = log.query({ agent: "alice" });
    expect(aliceEntries).toHaveLength(2);
  });

  it("should query by target_id", () => {
    log.log("dev", "alice", "task_created", "T1 created", { target_id: "task-1" });
    log.log("dev", "alice", "task_updated", "T2 updated", { target_id: "task-2" });
    log.log("dev", "alice", "task_completed", "T1 done", { target_id: "task-1" });

    const t1 = log.query({ target_id: "task-1" });
    expect(t1).toHaveLength(2);
  });

  it("should query with limit", () => {
    for (let i = 0; i < 10; i++) {
      log.log("dev", "alice", "task_created", `Entry ${i}`);
    }

    const limited = log.query({ limit: 3 });
    expect(limited).toHaveLength(3);
    // Should return the last 3 entries
    expect(limited[0]!.description).toBe("Entry 7");
    expect(limited[2]!.description).toBe("Entry 9");
  });

  it("should query with combined filters", () => {
    log.log("dev", "alice", "task_created", "A created", { target_id: "task-1" });
    log.log("dev", "bob", "task_created", "B created", { target_id: "task-2" });
    log.log("dev", "alice", "task_updated", "A updated", { target_id: "task-1" });

    const results = log.query({ agent: "alice", type: "task_created" });
    expect(results).toHaveLength(1);
    expect(results[0]!.description).toBe("A created");
  });

  // ── Persistence ───────────────────────────────────────────────────

  it("should persist and reload entries", async () => {
    log.log("dev", "alice", "task_created", "Persistent entry");
    await log.save();

    const reloaded = new ActivityLog(path.join(tmpDir, "activity"));
    await reloaded.load();

    expect(reloaded.size).toBe(1);
    const entries = reloaded.query({});
    expect(entries[0]!.description).toBe("Persistent entry");
  });

  it("should restore counter after reload", async () => {
    log.log("dev", "alice", "task_created", "Entry A");
    log.log("dev", "alice", "task_updated", "Entry B");
    await log.save();

    const reloaded = new ActivityLog(path.join(tmpDir, "activity"));
    await reloaded.load();

    const newEntry = reloaded.log("dev", "bob", "task_completed", "Entry C");
    expect(newEntry.id).toBe("act-2"); // continues from 2, not 0
  });

  // ── Broadcast callback ────────────────────────────────────────────

  it("should call broadcast callback on log", () => {
    const received: unknown[] = [];
    log.onEntry((entry) => received.push(entry));

    log.log("dev", "alice", "task_created", "Broadcasted");

    expect(received).toHaveLength(1);
    expect((received[0] as any).description).toBe("Broadcasted");
  });

  it("should not fail if broadcast callback throws", () => {
    log.onEntry(() => {
      throw new Error("Boom");
    });

    // Should not throw
    const entry = log.log("dev", "alice", "task_created", "Should not fail");
    expect(entry.id).toBe("act-0");
  });
});

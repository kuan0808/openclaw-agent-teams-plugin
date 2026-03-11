import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventQueue } from "../src/state/event-queue.js";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

const tmpDir = path.join(os.tmpdir(), "at-test-eq-" + Math.random().toString(36).slice(2));

describe("EventQueue", () => {
  let queue: EventQueue;

  beforeEach(async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    queue = new EventQueue(path.join(tmpDir, "events.json"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ── publish ──────────────────────────────────────────────────────────

  it("publish returns event ID string starting with 'ev-'", () => {
    const id = queue.publish("topic-a", "agent-1", "hello");
    expect(id).toMatch(/^ev-\d+$/);
  });

  it("publish increments counter", () => {
    const id1 = queue.publish("t", "a", "m1");
    const id2 = queue.publish("t", "a", "m2");
    const num1 = parseInt(id1.replace("ev-", ""), 10);
    const num2 = parseInt(id2.replace("ev-", ""), 10);
    expect(num2).toBe(num1 + 1);
  });

  // ── read / subscribe ─────────────────────────────────────────────────

  it("filters by topic", () => {
    queue.publish("alpha", "a", "msg1");
    queue.publish("beta", "a", "msg2");
    queue.publish("alpha", "a", "msg3");

    const results = queue.read("alpha");
    expect(results).toHaveLength(2);
    expect(results.every((e) => e.message === "msg1" || e.message === "msg3")).toBe(true);
  });

  it("topic '*' returns all events", () => {
    queue.publish("alpha", "a", "m1");
    queue.publish("beta", "b", "m2");

    const results = queue.read("*");
    expect(results).toHaveLength(2);
  });

  it("since timestamp filters correctly", () => {
    const t0 = 1_000_000;
    vi.spyOn(Date, "now").mockReturnValue(t0);
    queue.publish("t", "a", "old");

    vi.spyOn(Date, "now").mockReturnValue(t0 + 5_000);
    queue.publish("t", "a", "new");

    // since is exclusive (timestamp > since)
    const results = queue.read("t", t0);
    expect(results).toHaveLength(1);
    expect(results[0]!.message).toBe("new");
  });

  it("limit works", () => {
    for (let i = 0; i < 10; i++) {
      queue.publish("t", "a", `msg-${i}`);
    }

    const results = queue.read("t", undefined, 3);
    expect(results).toHaveLength(3);
    // limit takes the last N entries
    expect(results[0]!.message).toBe("msg-7");
    expect(results[2]!.message).toBe("msg-9");
  });

  // ── Ring buffer ──────────────────────────────────────────────────────

  it("trims oldest when exceeding maxBacklog", () => {
    const small = new EventQueue(path.join(tmpDir, "small.json"), { max_backlog: 5 });

    for (let i = 0; i < 8; i++) {
      small.publish("t", "a", `msg-${i}`);
    }

    const all = small.read("*");
    expect(all).toHaveLength(5);
    // Oldest 3 should have been trimmed
    expect(all[0]!.message).toBe("msg-3");
    expect(all[4]!.message).toBe("msg-7");
  });

  // ── getTopics ────────────────────────────────────────────────────────

  it("getTopics returns unique topic names", () => {
    queue.publish("beta", "a", "m");
    queue.publish("alpha", "a", "m");
    queue.publish("beta", "a", "m");

    const topics = queue.getTopics();
    expect(topics).toEqual(["alpha", "beta"]);
  });

  // ── clear ────────────────────────────────────────────────────────────

  it("clear removes all events but doesn't reset counter", () => {
    queue.publish("t", "a", "m1");
    queue.publish("t", "a", "m2");
    queue.clear();

    expect(queue.read("*")).toHaveLength(0);

    // Counter should continue from where it left off
    const id = queue.publish("t", "a", "m3");
    expect(id).toBe("ev-2");
  });

  // ── Persistence ──────────────────────────────────────────────────────

  it("save/load roundtrip", async () => {
    const filePath = path.join(tmpDir, "persist.json");
    const q1 = new EventQueue(filePath);
    q1.publish("topic-a", "agent-1", "hello");
    q1.publish("topic-b", "agent-2", "world");
    await q1.save();

    const q2 = new EventQueue(filePath);
    await q2.load();

    const all = q2.read("*");
    expect(all).toHaveLength(2);
    expect(all[0]!.message).toBe("hello");
    expect(all[1]!.message).toBe("world");

    // Counter should be restored — next id should be ev-2
    const nextId = q2.publish("t", "a", "after-load");
    expect(nextId).toBe("ev-2");
  });
});

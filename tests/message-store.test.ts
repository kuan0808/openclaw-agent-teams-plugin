import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MessageStore } from "../src/state/message-store.js";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

const tmpDir = path.join(os.tmpdir(), "at-test-msgstore-" + Math.random().toString(36).slice(2));

describe("MessageStore", () => {
  let store: MessageStore;

  beforeEach(async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    store = new MessageStore(path.join(tmpDir, "messages"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ── Normal push/read/ack flow ─────────────────────────────────────────

  describe("push/read/ack flow", () => {
    it("push adds a message and read retrieves it", () => {
      store.push("alice", "bob", "Hello Bob");

      const msgs = store.read("bob");
      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.from).toBe("alice");
      expect(msgs[0]!.message).toBe("Hello Bob");
      expect(msgs[0]!.time).toBeTruthy();
    });

    it("read only returns messages for the specified member", () => {
      store.push("alice", "bob", "For Bob");
      store.push("alice", "carol", "For Carol");

      const bobMsgs = store.read("bob");
      expect(bobMsgs).toHaveLength(1);
      expect(bobMsgs[0]!.message).toBe("For Bob");

      const carolMsgs = store.read("carol");
      expect(carolMsgs).toHaveLength(1);
      expect(carolMsgs[0]!.message).toBe("For Carol");
    });

    it("read with ack=true marks messages as acked", () => {
      store.push("alice", "bob", "Message 1");
      store.push("alice", "bob", "Message 2");

      // First read with ack
      const first = store.read("bob", undefined, true);
      expect(first).toHaveLength(2);

      // Second read — messages already acked, should return empty
      const second = store.read("bob");
      expect(second).toHaveLength(0);
    });

    it("read without ack keeps messages unread", () => {
      store.push("alice", "bob", "Persistent message");

      const first = store.read("bob");
      expect(first).toHaveLength(1);

      // Still unread
      const second = store.read("bob");
      expect(second).toHaveLength(1);
    });

    it("read with limit returns only N messages", () => {
      store.push("alice", "bob", "Msg 1");
      store.push("alice", "bob", "Msg 2");
      store.push("alice", "bob", "Msg 3");

      const limited = store.read("bob", 2);
      expect(limited).toHaveLength(2);
      expect(limited[0]!.message).toBe("Msg 1");
      expect(limited[1]!.message).toBe("Msg 2");
    });
  });

  // ── Bounded growth (maxMessages) ──────────────────────────────────────

  describe("bounded growth", () => {
    it("trims acked messages when exceeding maxMessages", () => {
      const bounded = new MessageStore(path.join(tmpDir, "bounded"), 5);

      // Push 5 messages, ack them all
      for (let i = 0; i < 5; i++) {
        bounded.push("alice", "bob", `Msg ${i}`);
      }
      bounded.read("bob", undefined, true); // ack all

      // Push one more — should trigger trim of acked messages
      bounded.push("alice", "bob", "Msg 5");

      // The new message should be readable
      const msgs = bounded.read("bob");
      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.message).toBe("Msg 5");
    });

    it("preserves unacked messages during trim", () => {
      const bounded = new MessageStore(path.join(tmpDir, "bounded-unacked"), 5);

      // Push 3 messages to bob (unacked)
      bounded.push("alice", "bob", "Unacked 1");
      bounded.push("alice", "bob", "Unacked 2");
      bounded.push("alice", "bob", "Unacked 3");

      // Push 2 messages to carol, ack them
      bounded.push("alice", "carol", "Carol 1");
      bounded.push("alice", "carol", "Carol 2");
      bounded.read("carol", undefined, true); // ack carol's messages

      // Push one more — exceeds limit, should trim acked (carol's) messages first
      bounded.push("alice", "bob", "Unacked 4");

      // Bob's unacked messages should all survive
      const bobMsgs = bounded.read("bob");
      expect(bobMsgs.length).toBeGreaterThanOrEqual(4);
      expect(bobMsgs.map((m) => m.message)).toContain("Unacked 1");
      expect(bobMsgs.map((m) => m.message)).toContain("Unacked 4");
    });

    it("handles case where all messages are unacked (no trim possible)", () => {
      const bounded = new MessageStore(path.join(tmpDir, "bounded-all-unacked"), 3);

      // Push 4 messages — none are acked, so trim can't remove any
      bounded.push("alice", "bob", "Msg 1");
      bounded.push("alice", "bob", "Msg 2");
      bounded.push("alice", "bob", "Msg 3");
      bounded.push("alice", "bob", "Msg 4");

      // All unacked messages should still be readable
      const msgs = bounded.read("bob");
      expect(msgs).toHaveLength(4);
    });
  });

  // ── Clear ─────────────────────────────────────────────────────────────

  describe("clear", () => {
    it("removes all messages", () => {
      store.push("alice", "bob", "Message 1");
      store.push("alice", "carol", "Message 2");
      store.clear();

      expect(store.read("bob")).toHaveLength(0);
      expect(store.read("carol")).toHaveLength(0);
    });
  });

  // ── Persistence ───────────────────────────────────────────────────────

  describe("persistence", () => {
    it("save/load roundtrip", async () => {
      const dir = path.join(tmpDir, "persist-msgs");
      const s1 = new MessageStore(dir);
      await s1.load();
      s1.push("alice", "bob", "Persisted message");
      await s1.save();

      const s2 = new MessageStore(dir);
      await s2.load();
      const msgs = s2.read("bob");
      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.message).toBe("Persisted message");
    });
  });
});

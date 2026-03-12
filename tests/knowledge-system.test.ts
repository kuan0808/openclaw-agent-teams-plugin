import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { KvStore } from "../src/state/kv-store.js";
import { clearLearnings, consolidateLearnings } from "../src/tools/tool-helpers.js";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

const tmpDir = path.join(os.tmpdir(), "at-test-knowledge-" + Math.random().toString(36).slice(2));

describe("Knowledge System", () => {
  let kv: KvStore;

  beforeEach(async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    kv = new KvStore(path.join(tmpDir, "kv.json"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ── clearLearnings ────────────────────────────────────────────────────

  describe("clearLearnings", () => {
    it("removes all learnings:* keys", () => {
      kv.set("learnings:pattern:caching", {
        content: "Use caching for repeated lookups",
        confidence: 0.8,
        category: "pattern",
        timestamp: Date.now(),
      }, "agent-a");
      kv.set("learnings:failure:timeout", {
        content: "API calls can timeout after 30s",
        confidence: 0.9,
        category: "failure",
        timestamp: Date.now(),
      }, "agent-b");
      kv.set("learnings:legacy-topic", "some old learning", "agent-c");

      const removed = clearLearnings(kv);
      expect(removed).toBe(3);

      // Verify they're gone
      expect(kv.get("learnings:pattern:caching")).toEqual({ found: false });
      expect(kv.get("learnings:failure:timeout")).toEqual({ found: false });
      expect(kv.get("learnings:legacy-topic")).toEqual({ found: false });
    });

    it("preserves non-learning keys", () => {
      kv.set("config:theme", "dark", "agent-a");
      kv.set("counter:deploys", 42, "agent-b");
      kv.set("learnings:pattern:x", {
        content: "something",
        confidence: 0.5,
        category: "pattern",
        timestamp: Date.now(),
      }, "agent-a");

      const removed = clearLearnings(kv);
      expect(removed).toBe(1);

      // Non-learning keys should survive
      expect(kv.get("config:theme")).toEqual(
        expect.objectContaining({ found: true, value: "dark" }),
      );
      expect(kv.get("counter:deploys")).toEqual(
        expect.objectContaining({ found: true, value: 42 }),
      );
    });

    it("returns 0 when no learnings exist", () => {
      kv.set("config:theme", "dark", "agent-a");
      const removed = clearLearnings(kv);
      expect(removed).toBe(0);
    });

    it("returns 0 on empty store", () => {
      const removed = clearLearnings(kv);
      expect(removed).toBe(0);
    });
  });

  // ── consolidateLearnings ──────────────────────────────────────────────

  describe("consolidateLearnings", () => {
    it("produces summary entry from structured learnings", () => {
      kv.set("learnings:pattern:caching", {
        content: "Use caching for repeated lookups",
        confidence: 0.8,
        category: "pattern",
        timestamp: Date.now(),
      }, "agent-a");
      kv.set("learnings:failure:timeout", {
        content: "API calls can timeout after 30s",
        confidence: 0.9,
        category: "failure",
        timestamp: Date.now(),
      }, "agent-b");
      kv.set("learnings:insight:perf", {
        content: "Batch queries are 10x faster",
        confidence: 0.7,
        category: "insight",
        timestamp: Date.now(),
      }, "agent-a");

      const result = consolidateLearnings(kv, "tr-20260312-run1");

      expect(result.count).toBe(3);
      expect(result.categories).toHaveProperty("pattern");
      expect(result.categories).toHaveProperty("failure");
      expect(result.categories).toHaveProperty("insight");
      expect(result.categories.pattern).toBe(1);
      expect(result.categories.failure).toBe(1);
      expect(result.categories.insight).toBe(1);

      // Check that consolidated entry was stored
      const consolidated = kv.get("learnings:consolidated:tr-20260312-run1");
      expect(consolidated.found).toBe(true);
      if (consolidated.found) {
        const value = consolidated.value as Record<string, unknown>;
        expect(value.run_id).toBe("tr-20260312-run1");
        expect(value.total).toBe(3);
        expect(typeof value.content).toBe("string");
        expect(value.consolidated_at).toBeGreaterThan(0);
      }
    });

    it("returns { count: 0, categories: {} } with empty learnings", () => {
      // No learnings in store
      kv.set("config:theme", "dark", "agent-a");

      const result = consolidateLearnings(kv, "tr-empty");
      expect(result).toEqual({ count: 0, categories: {} });

      // No consolidated entry should be stored
      expect(kv.get("learnings:consolidated:tr-empty")).toEqual({ found: false });
    });

    it("handles legacy flat learnings (non-structured)", () => {
      kv.set("learnings:some-topic", "A plain string learning", "agent-a");

      const result = consolidateLearnings(kv, "tr-legacy");
      expect(result.count).toBe(1);
      // Legacy entries get category "uncategorized" by default
      expect(result.categories).toHaveProperty("uncategorized", 1);
    });

    it("groups learnings by category in the summary", () => {
      // 2 pattern learnings and 1 failure learning
      kv.set("learnings:pattern:a", {
        content: "Pattern A",
        confidence: 0.9,
        category: "pattern",
        timestamp: Date.now(),
      }, "agent-a");
      kv.set("learnings:pattern:b", {
        content: "Pattern B",
        confidence: 0.7,
        category: "pattern",
        timestamp: Date.now(),
      }, "agent-a");
      kv.set("learnings:failure:c", {
        content: "Failure C",
        confidence: 0.8,
        category: "failure",
        timestamp: Date.now(),
      }, "agent-b");

      const result = consolidateLearnings(kv, "tr-grouped");
      expect(result.count).toBe(3);
      expect(result.categories.pattern).toBe(2);
      expect(result.categories.failure).toBe(1);
    });
  });
});

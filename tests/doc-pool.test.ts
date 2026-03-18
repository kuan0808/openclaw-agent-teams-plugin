import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DocPool } from "../src/state/doc-pool.js";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

const tmpDir = path.join(os.tmpdir(), "at-test-docpool-" + Math.random().toString(36).slice(2));

describe("DocPool", () => {
  let pool: DocPool;

  beforeEach(async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    pool = new DocPool(path.join(tmpDir, "docs"));
    await pool.load();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ── Path traversal protection ─────────────────────────────────────────

  describe("path traversal protection", () => {
    it("rejects keys containing '..'", async () => {
      await expect(
        pool.set("../etc/passwd", "evil", "text/plain", "attacker"),
      ).rejects.toThrow("must not contain");
    });

    it("rejects keys containing '/'", async () => {
      await expect(
        pool.set("sub/key", "data", "text/plain", "attacker"),
      ).rejects.toThrow("must not contain");
    });

    it("rejects keys containing '\\'", async () => {
      await expect(
        pool.set("sub\\key", "data", "text/plain", "attacker"),
      ).rejects.toThrow("must not contain");
    });

    it("rejects traversal on get", async () => {
      await expect(pool.get("../../secret")).rejects.toThrow("must not contain");
    });

    it("rejects traversal on delete", async () => {
      await expect(pool.delete("../nope")).rejects.toThrow("must not contain");
    });

    it("allows normal keys without path separators", async () => {
      const result = await pool.set("my-doc", "hello world", "text/plain", "agent-a");
      expect(result.ok).toBe(true);
      expect(result.size_bytes).toBeGreaterThan(0);
    });

    it("allows keys with dots that are not traversal", async () => {
      const result = await pool.set("config.v2", '{"a":1}', "application/json", "agent-a");
      expect(result.ok).toBe(true);
    });
  });

  // ── Basic CRUD operations ─────────────────────────────────────────────

  describe("CRUD operations", () => {
    it("set and get roundtrip", async () => {
      await pool.set("readme", "# Hello", "text/markdown", "agent-a");
      const result = await pool.get("readme");

      expect(result.found).toBe(true);
      if (result.found) {
        expect(result.value).toBe("# Hello");
        expect(result.content_type).toBe("text/markdown");
        expect(result.written_by).toBe("agent-a");
      }
    });

    it("get returns { found: false } for missing key", async () => {
      const result = await pool.get("nonexistent");
      expect(result).toEqual({ found: false });
    });

    it("set overwrites existing document", async () => {
      await pool.set("doc", "version 1", "text/plain", "agent-a");
      await pool.set("doc", "version 2", "text/plain", "agent-b");

      const result = await pool.get("doc");
      expect(result.found).toBe(true);
      if (result.found) {
        expect(result.value).toBe("version 2");
        expect(result.written_by).toBe("agent-b");
      }
    });

    it("delete removes a document", async () => {
      await pool.set("temp", "temporary data", "text/plain", "agent-a");
      const deleted = await pool.delete("temp");
      expect(deleted).toBe(true);

      const result = await pool.get("temp");
      expect(result).toEqual({ found: false });
    });

    it("delete returns false for non-existent key", async () => {
      const deleted = await pool.delete("nonexistent");
      expect(deleted).toBe(false);
    });

    it("list returns all stored documents", async () => {
      await pool.set("doc1", "content 1", "text/plain", "agent-a");
      await pool.set("doc2", '{"x":1}', "application/json", "agent-b");

      const entries = pool.list();
      expect(entries).toHaveLength(2);
      expect(entries[0]!.key).toBe("doc1");
      expect(entries[0]!.content_type).toBe("text/plain");
      expect(entries[0]!.written_by).toBe("agent-a");
      expect(entries[0]!.size_bytes).toBeGreaterThan(0);
      expect(entries[1]!.key).toBe("doc2");
    });

    it("list returns empty array when no documents", () => {
      const entries = pool.list();
      expect(entries).toHaveLength(0);
    });
  });

  // ── Content type validation ───────────────────────────────────────────

  describe("content type validation", () => {
    it("rejects unsupported content types", async () => {
      await expect(
        pool.set("binary", "data", "application/octet-stream", "agent-a"),
      ).rejects.toThrow("not allowed");
    });

    it("accepts text/plain", async () => {
      const result = await pool.set("plain", "text", "text/plain", "agent-a");
      expect(result.ok).toBe(true);
    });

    it("accepts text/markdown", async () => {
      const result = await pool.set("md", "# Title", "text/markdown", "agent-a");
      expect(result.ok).toBe(true);
    });

    it("accepts application/json", async () => {
      const result = await pool.set("data", '{}', "application/json", "agent-a");
      expect(result.ok).toBe(true);
    });

    it("accepts text/csv", async () => {
      const result = await pool.set("data", "a,b,c", "text/csv", "agent-a");
      expect(result.ok).toBe(true);
    });
  });

  // ── Persistence ───────────────────────────────────────────────────────

  describe("persistence", () => {
    it("save/load roundtrip preserves documents", async () => {
      const docsDir = path.join(tmpDir, "persist-docs");
      const p1 = new DocPool(docsDir);
      await p1.load();
      await p1.set("key1", "value1", "text/plain", "writer");
      await p1.save();

      const p2 = new DocPool(docsDir);
      await p2.load();
      const result = await p2.get("key1");
      expect(result.found).toBe(true);
      if (result.found) {
        expect(result.value).toBe("value1");
      }
    });
  });
});

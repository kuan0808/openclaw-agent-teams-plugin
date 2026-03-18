import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { KvStore } from "../src/state/kv-store.js";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

const tmpDir = path.join(os.tmpdir(), "at-test-kv-" + Math.random().toString(36).slice(2));

describe("KvStore", () => {
  let store: KvStore;

  beforeEach(async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    store = new KvStore(path.join(tmpDir, "kv.json"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ── Constructor ──────────────────────────────────────────────────────

  it("creates with default config", () => {
    // No config passed — should not throw
    const s = new KvStore(path.join(tmpDir, "default.json"));
    expect(s).toBeInstanceOf(KvStore);
  });

  // ── set / get ────────────────────────────────────────────────────────

  it("basic write/read roundtrip", () => {
    store.set("greeting", "hello", "agent-a");
    const result = store.get("greeting");
    expect(result).toEqual(
      expect.objectContaining({ found: true, value: "hello", written_by: "agent-a" }),
    );
  });

  it("set returns { ok: true, replaced: false } on new key", () => {
    const result = store.set("k1", 42, "agent-a");
    expect(result).toEqual({ ok: true, replaced: false });
  });

  it("set returns { ok: true, replaced: true } on overwrite", () => {
    store.set("k1", 1, "agent-a");
    const result = store.set("k1", 2, "agent-b");
    expect(result).toEqual({ ok: true, replaced: true });
  });

  it("get returns { found: false } for missing key", () => {
    const result = store.get("nonexistent");
    expect(result).toEqual({ found: false });
  });

  // ── TTL ──────────────────────────────────────────────────────────────

  it("entry with TTL expires after time passes", () => {
    const now = 1_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);

    store.set("temp", "value", "agent-a", 10); // 10 seconds TTL

    // Still alive right after creation
    expect(store.get("temp")).toEqual(
      expect.objectContaining({ found: true, value: "value" }),
    );

    // Advance past expiry (10s = 10_000ms)
    vi.spyOn(Date, "now").mockReturnValue(now + 10_001);
    expect(store.get("temp")).toEqual({ found: false });
  });

  it("get returns ttl_remaining for entries with TTL", () => {
    const now = 1_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);

    store.set("temp", "value", "agent-a", 60); // 60 seconds TTL

    // 20 seconds later
    vi.spyOn(Date, "now").mockReturnValue(now + 20_000);
    const result = store.get("temp");
    expect(result).toEqual(
      expect.objectContaining({ found: true, ttl_remaining: 40 }),
    );
  });

  // ── delete ───────────────────────────────────────────────────────────

  it("delete removes entry", () => {
    store.set("k1", "v1", "agent-a");
    expect(store.delete("k1")).toBe(true);
    expect(store.get("k1")).toEqual({ found: false });
  });

  // ── list ─────────────────────────────────────────────────────────────

  it("list returns all entries with key, written_by, size", () => {
    store.set("a", "hello", "agent-a");
    store.set("b", { x: 1 }, "agent-b");

    const items = store.list();
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual(
      expect.objectContaining({ key: "a", written_by: "agent-a" }),
    );
    expect(items[0]!.size).toBeGreaterThan(0);
  });

  it("list sweeps expired entries", () => {
    const now = 1_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);

    store.set("alive", "yes", "agent-a");
    store.set("dying", "bye", "agent-a", 5); // 5 seconds

    // Advance past TTL
    vi.spyOn(Date, "now").mockReturnValue(now + 6_000);

    const items = store.list();
    expect(items).toHaveLength(1);
    expect(items[0]!.key).toBe("alive");
  });

  // ── max_entries ──────────────────────────────────────────────────────

  it("evicts oldest when limit exceeded", () => {
    const small = new KvStore(path.join(tmpDir, "small.json"), { max_entries: 3 });
    small.set("a", 1, "x");
    small.set("b", 2, "x");
    small.set("c", 3, "x");
    small.set("d", 4, "x"); // should evict "a"

    expect(small.get("a")).toEqual({ found: false });
    expect(small.get("d")).toEqual(expect.objectContaining({ found: true, value: 4 }));
    expect(small.list()).toHaveLength(3);
  });

  // ── clear ────────────────────────────────────────────────────────────

  it("clear removes all entries", () => {
    store.set("a", 1, "x");
    store.set("b", 2, "x");
    store.clear();
    expect(store.list()).toHaveLength(0);
  });

  // ── Persistence ──────────────────────────────────────────────────────

  it("save/load roundtrip", async () => {
    const filePath = path.join(tmpDir, "persist.json");
    const s1 = new KvStore(filePath);
    s1.set("key1", "value1", "writer");
    s1.set("key2", { nested: true }, "writer");
    await s1.save();

    const s2 = new KvStore(filePath);
    await s2.load();

    const r1 = s2.get("key1");
    expect(r1).toEqual(expect.objectContaining({ found: true, value: "value1" }));
    const r2 = s2.get("key2");
    expect(r2).toEqual(expect.objectContaining({ found: true, value: { nested: true } }));
  });
});

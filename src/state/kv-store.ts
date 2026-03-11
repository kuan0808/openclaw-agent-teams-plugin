/**
 * Key-Value store with TTL support and lazy expiry cleanup.
 *
 * Entries are kept in-memory and persisted to a single JSON file.
 * TTL is enforced lazily — expired entries are removed on access and
 * during list/sweep operations.
 */

import type { KvEntry, KvStoreConfig } from "../types.js";
import { readJson, writeJson } from "./persistence.js";

const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_TTL = 0; // 0 = no expiry

export class KvStore {
  private entries: Map<string, KvEntry> = new Map();
  private persistPath: string;
  private maxEntries: number;
  private defaultTtl: number;

  constructor(persistPath: string, config?: KvStoreConfig) {
    this.persistPath = persistPath;
    this.maxEntries = config?.max_entries ?? DEFAULT_MAX_ENTRIES;
    this.defaultTtl = config?.ttl ?? DEFAULT_TTL;
  }

  // ── Disk I/O ────────────────────────────────────────────────────────

  async load(): Promise<void> {
    const raw = await readJson<KvEntry[]>(this.persistPath, []);
    this.entries.clear();
    for (const entry of raw) {
      this.entries.set(entry.key, entry);
    }
    this.sweepExpired();
  }

  async save(): Promise<void> {
    const arr = Array.from(this.entries.values());
    await writeJson(this.persistPath, arr);
  }

  // ── CRUD ────────────────────────────────────────────────────────────

  set(
    key: string,
    value: unknown,
    writtenBy: string,
    ttl?: number,
  ): { ok: true; replaced: boolean } {
    const now = Date.now();
    const effectiveTtl = ttl ?? (this.defaultTtl > 0 ? this.defaultTtl : undefined);
    const replaced = this.entries.has(key);

    const existing = this.entries.get(key);

    const entry: KvEntry = {
      key,
      value,
      written_by: writtenBy,
      created_at: existing?.created_at ?? now,
      updated_at: now,
      ...(effectiveTtl != null && effectiveTtl > 0
        ? { ttl: effectiveTtl, expires_at: now + effectiveTtl * 1000 }
        : {}),
    };

    this.entries.set(key, entry);

    // Enforce max_entries — evict oldest by created_at
    if (this.entries.size > this.maxEntries) {
      this.evictOldest();
    }

    return { ok: true, replaced };
  }

  get(
    key: string,
  ):
    | { found: true; value: unknown; written_by: string; ttl_remaining?: number }
    | { found: false } {
    const entry = this.entries.get(key);
    if (!entry) return { found: false };

    if (this.isExpired(entry)) {
      this.entries.delete(key);
      return { found: false };
    }

    const result: { found: true; value: unknown; written_by: string; ttl_remaining?: number } = {
      found: true,
      value: entry.value,
      written_by: entry.written_by,
    };

    if (entry.expires_at != null) {
      result.ttl_remaining = Math.max(0, Math.round((entry.expires_at - Date.now()) / 1000));
    }

    return result;
  }

  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  list(): Array<{ key: string; written_by: string; size: number }> {
    this.sweepExpired();

    return Array.from(this.entries.values()).map((e) => ({
      key: e.key,
      written_by: e.written_by,
      size: JSON.stringify(e.value).length,
    }));
  }

  clear(): void {
    this.entries.clear();
  }

  /**
   * Iterate all non-expired entries. Useful for single-pass operations
   * that need both key and value without the N+1 of list() + get().
   */
  *iterEntries(): IterableIterator<[string, KvEntry]> {
    for (const [key, entry] of this.entries) {
      if (this.isExpired(entry)) {
        this.entries.delete(key);
        continue;
      }
      yield [key, entry];
    }
  }

  // ── TTL helpers ─────────────────────────────────────────────────────

  private isExpired(entry: KvEntry): boolean {
    if (entry.expires_at == null) return false;
    return Date.now() >= entry.expires_at;
  }

  private sweepExpired(): void {
    for (const [key, entry] of this.entries) {
      if (this.isExpired(entry)) {
        this.entries.delete(key);
      }
    }
  }

  /**
   * Evict entries beyond maxEntries, oldest first (by created_at).
   * Sorts once then deletes — O(n log n) total, not per eviction.
   */
  private evictOldest(): void {
    if (this.entries.size <= this.maxEntries) return;
    const sorted = Array.from(this.entries.values()).sort(
      (a, b) => a.created_at - b.created_at,
    );
    let i = 0;
    while (this.entries.size > this.maxEntries && i < sorted.length) {
      this.entries.delete(sorted[i]!.key);
      i++;
    }
  }
}

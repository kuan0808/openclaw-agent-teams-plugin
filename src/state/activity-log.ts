/**
 * Append-only activity log for audit trail.
 *
 * Unlike EventQueue (ring buffer), this log is persistent and complete.
 * Auto-archives when exceeding MAX_ENTRIES. Each entry has a structured
 * type and agent attribution.
 */

import type { ActivityEntry, ActivityType } from "../types.js";
import { readJson, writeJson, ensureDir } from "./persistence.js";
import { restoreCounter } from "../tools/tool-helpers.js";
import * as path from "node:path";

const MAX_ENTRIES = 10_000;
const ARCHIVE_BATCH = 5_000; // how many to archive when exceeding max

export class ActivityLog {
  private entries: ActivityEntry[] = [];
  private baseDir: string;
  private counter = 0;
  private broadcastCallback?: (entry: ActivityEntry) => void;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  /** Set a callback that fires on every log entry (for broadcasting). */
  onEntry(callback: (entry: ActivityEntry) => void): void {
    this.broadcastCallback = callback;
  }

  // ── Disk I/O ────────────────────────────────────────────────────────

  async load(): Promise<void> {
    await ensureDir(this.baseDir);
    this.entries = await readJson<ActivityEntry[]>(
      path.join(this.baseDir, "activity.json"),
      [],
    );
    this.counter = restoreCounter(this.entries, "act-");
  }

  async save(): Promise<void> {
    // Archive old entries before saving (data-safe: write archive first)
    if (this.entries.length > MAX_ENTRIES) {
      await this.archiveOldest();
    }

    await writeJson(
      path.join(this.baseDir, "activity.json"),
      this.entries,
    );
  }

  // ── Logging ─────────────────────────────────────────────────────────

  log(
    team: string,
    agent: string,
    type: ActivityType,
    description: string,
    opts?: {
      target_id?: string;
      metadata?: Record<string, unknown>;
    },
  ): ActivityEntry {
    const entry: ActivityEntry = {
      id: `act-${this.counter++}`,
      timestamp: Date.now(),
      team,
      agent,
      type,
      description,
      ...(opts?.target_id != null ? { target_id: opts.target_id } : {}),
      ...(opts?.metadata != null ? { metadata: opts.metadata } : {}),
    };

    this.entries.push(entry);

    // Notify broadcast callback
    if (this.broadcastCallback) {
      try {
        this.broadcastCallback(entry);
      } catch {
        // Don't let broadcast failures break logging
      }
    }

    return entry;
  }

  // ── Query ───────────────────────────────────────────────────────────

  query(opts?: {
    type?: ActivityType;
    agent?: string;
    target_id?: string;
    since?: number;
    limit?: number;
  }): ActivityEntry[] {
    // Single-pass filter
    let results = this.entries.filter((e) =>
      (!opts?.type || e.type === opts.type) &&
      (!opts?.agent || e.agent === opts.agent) &&
      (!opts?.target_id || e.target_id === opts.target_id) &&
      (!opts?.since || e.timestamp > opts.since),
    );

    if (opts?.limit && opts.limit > 0) {
      results = results.slice(-opts.limit);
    }

    return results;
  }

  /** Get total entry count. */
  get size(): number {
    return this.entries.length;
  }

  // ── Internal ────────────────────────────────────────────────────────

  /**
   * Move the oldest ARCHIVE_BATCH entries to an archive file,
   * keeping the recent entries in the main log.
   *
   * Called during save() — archive is written to disk first, then
   * entries are removed from memory. This prevents data loss.
   */
  private async archiveOldest(): Promise<void> {
    if (this.entries.length <= MAX_ENTRIES) return;

    const toArchive = this.entries.slice(0, ARCHIVE_BATCH);
    const archiveFile = path.join(
      this.baseDir,
      `archive-${Date.now()}.json`,
    );

    // Write archive to disk first — only remove from memory on success
    await writeJson(archiveFile, toArchive);
    this.entries.splice(0, ARCHIVE_BATCH);
  }
}

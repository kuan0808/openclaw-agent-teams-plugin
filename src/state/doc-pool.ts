/**
 * File-backed document pool with MIME type awareness.
 *
 * Each document is stored as an individual file under `baseDir`.
 * A companion `_index.json` tracks metadata (content type, size, authorship).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DocEntry, DocPoolConfig } from "../types.js";
import { readJson, writeJson, ensureDir } from "./persistence.js";

const DEFAULT_MAX_SIZE_MB = 50;
const DEFAULT_ALLOWED_TYPES = [
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
];

/** Map of content-type to file extension. */
const EXTENSION_MAP: Record<string, string> = {
  "text/markdown": ".md",
  "application/json": ".json",
  "text/csv": ".csv",
  "text/plain": ".txt",
};

function extensionFor(contentType: string): string {
  return EXTENSION_MAP[contentType] ?? ".bin";
}

export class DocPool {
  private index: DocEntry[] = [];
  private baseDir: string;
  private indexPath: string;
  private maxSizeMb: number;
  private allowedTypes: string[];

  constructor(baseDir: string, config?: DocPoolConfig) {
    this.baseDir = baseDir;
    this.indexPath = path.join(baseDir, "_index.json");
    this.maxSizeMb = config?.max_size_mb ?? DEFAULT_MAX_SIZE_MB;
    this.allowedTypes = config?.allowed_types ?? DEFAULT_ALLOWED_TYPES;
  }

  // ── Disk I/O ────────────────────────────────────────────────────────

  async load(): Promise<void> {
    await ensureDir(this.baseDir);
    this.index = await readJson<DocEntry[]>(this.indexPath, []);
  }

  async save(): Promise<void> {
    await writeJson(this.indexPath, this.index);
  }

  // ── CRUD ────────────────────────────────────────────────────────────

  async set(
    key: string,
    value: string,
    contentType: string,
    writtenBy: string,
  ): Promise<{ ok: true; size_bytes: number; path: string }> {
    // Validate content type
    if (!this.allowedTypes.includes(contentType)) {
      throw new Error(
        `Content type "${contentType}" not allowed. Allowed: ${this.allowedTypes.join(", ")}`,
      );
    }

    await ensureDir(this.baseDir);

    const ext = extensionFor(contentType);
    const filePath = path.join(this.baseDir, `${key}${ext}`);
    const sizeBytes = Buffer.byteLength(value, "utf-8");

    // Check total pool size (excluding current key's old size)
    const currentTotal = this.totalSizeBytes(key);
    const maxBytes = this.maxSizeMb * 1024 * 1024;
    if (currentTotal + sizeBytes > maxBytes) {
      throw new Error(
        `Document pool size would exceed limit (${this.maxSizeMb} MB). ` +
          `Current: ${(currentTotal / 1024 / 1024).toFixed(2)} MB, ` +
          `new doc: ${(sizeBytes / 1024 / 1024).toFixed(2)} MB`,
      );
    }

    // Write the file
    await fs.writeFile(filePath, value, "utf-8");

    // Update index
    const now = Date.now();
    const existing = this.index.findIndex((e) => e.key === key);

    const entry: DocEntry = {
      key,
      content_type: contentType,
      size_bytes: sizeBytes,
      written_by: writtenBy,
      created_at: existing !== -1 ? this.index[existing].created_at : now,
      updated_at: now,
    };

    if (existing !== -1) {
      // If content type changed, remove old file (different extension)
      const oldExt = extensionFor(this.index[existing].content_type);
      if (oldExt !== ext) {
        const oldPath = path.join(this.baseDir, `${key}${oldExt}`);
        await fs.unlink(oldPath).catch(() => {});
      }
      this.index[existing] = entry;
    } else {
      this.index.push(entry);
    }

    return { ok: true, size_bytes: sizeBytes, path: filePath };
  }

  async get(
    key: string,
  ): Promise<
    | { found: true; value: string; content_type: string; written_by: string }
    | { found: false }
  > {
    const entry = this.index.find((e) => e.key === key);
    if (!entry) return { found: false };

    const ext = extensionFor(entry.content_type);
    const filePath = path.join(this.baseDir, `${key}${ext}`);

    try {
      const value = await fs.readFile(filePath, "utf-8");
      return {
        found: true,
        value,
        content_type: entry.content_type,
        written_by: entry.written_by,
      };
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        // Index references a file that no longer exists on disk — clean up
        this.index = this.index.filter((e) => e.key !== key);
        return { found: false };
      }
      throw err;
    }
  }

  async delete(key: string): Promise<boolean> {
    const idx = this.index.findIndex((e) => e.key === key);
    if (idx === -1) return false;

    const entry = this.index[idx];
    const ext = extensionFor(entry.content_type);
    const filePath = path.join(this.baseDir, `${key}${ext}`);

    // Remove file (ignore if already gone)
    await fs.unlink(filePath).catch(() => {});

    // Remove from index
    this.index.splice(idx, 1);

    return true;
  }

  list(): Array<{
    key: string;
    content_type: string;
    size_bytes: number;
    written_by: string;
    updated_at: number;
  }> {
    return this.index.map((e) => ({
      key: e.key,
      content_type: e.content_type,
      size_bytes: e.size_bytes,
      written_by: e.written_by,
      updated_at: e.updated_at,
    }));
  }

  async clear(): Promise<void> {
    // Delete all tracked files
    for (const entry of this.index) {
      const ext = extensionFor(entry.content_type);
      const filePath = path.join(this.baseDir, `${entry.key}${ext}`);
      await fs.unlink(filePath).catch(() => {});
    }
    this.index = [];
  }

  // ── Internal ────────────────────────────────────────────────────────

  /**
   * Sum of all stored document sizes, optionally excluding a key
   * (for replacement size checks).
   */
  private totalSizeBytes(excludeKey?: string): number {
    let total = 0;
    for (const entry of this.index) {
      if (entry.key !== excludeKey) {
        total += entry.size_bytes;
      }
    }
    return total;
  }
}

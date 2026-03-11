/**
 * File-based event broadcast (.jsonl).
 *
 * Appends one JSON line per event to a broadcast file. External tools
 * can monitor with `tail -f broadcast.jsonl | jq`. Designed for future
 * upgrade to SSE/WebSocket.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ActivityEntry, BroadcastEvent } from "./types.js";
import { ensureDir } from "./state/persistence.js";
import { restoreCounter } from "./tools/tool-helpers.js";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB before rotation

export class Broadcaster {
  private filePath: string;
  private enabled: boolean;
  private counter = 0;
  private currentSize = 0; // track file size in memory to avoid stat per write
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string, enabled = true) {
    this.filePath = filePath;
    this.enabled = enabled;
  }

  /** Initialize the broadcast file directory and restore counter from existing file. */
  async init(): Promise<void> {
    if (!this.enabled) return;
    await ensureDir(path.dirname(this.filePath));

    // Restore counter and file size from existing broadcast file
    try {
      const content = await fs.readFile(this.filePath, "utf-8");
      this.currentSize = Buffer.byteLength(content, "utf-8");
      const parsed: Array<{ id: string }> = [];
      for (const line of content.trim().split("\n")) {
        if (!line) continue;
        try { parsed.push(JSON.parse(line)); } catch { /* skip malformed */ }
      }
      this.counter = restoreCounter(parsed, "evt-");
    } catch {
      // File doesn't exist yet — counter stays at 0
    }
  }

  /** Convert an ActivityEntry to a BroadcastEvent and append to file. */
  emit(entry: ActivityEntry): void {
    if (!this.enabled) return;

    const event: BroadcastEvent = {
      id: `evt-${this.counter++}`,
      type: entry.type,
      team: entry.team,
      agent: entry.agent,
      data: {
        description: entry.description,
        target_id: entry.target_id,
        ...entry.metadata,
      },
      ts: entry.timestamp,
    };

    const line = JSON.stringify(event) + "\n";

    // Chain writes to avoid race conditions
    this.writeQueue = this.writeQueue
      .then(() => this.appendLine(line))
      .catch(() => {
        // Broadcast write failure is non-fatal
      });
  }

  private async appendLine(line: string): Promise<void> {
    try {
      // Check in-memory file size for rotation
      if (this.currentSize > MAX_FILE_SIZE) {
        await this.rotate();
      }

      await fs.appendFile(this.filePath, line, "utf-8");
      this.currentSize += Buffer.byteLength(line, "utf-8");
    } catch {
      // Non-fatal — broadcasting is best-effort
    }
  }

  private async rotate(): Promise<void> {
    const rotatedPath = `${this.filePath}.${Date.now()}`;
    try {
      await fs.rename(this.filePath, rotatedPath);
      this.currentSize = 0;
    } catch {
      // If rotation fails, continue writing to existing file
    }
  }
}

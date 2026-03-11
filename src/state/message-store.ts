/**
 * Simple per-member message queue with persistence.
 *
 * Messages are stored per-recipient for efficient retrieval.
 */

import type { MessageEntry } from "../types.js";
import { readJson, writeJson, ensureDir } from "./persistence.js";
import * as path from "node:path";

export class MessageStore {
  private messages: MessageEntry[] = [];
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  async load(): Promise<void> {
    await ensureDir(this.baseDir);
    this.messages = await readJson<MessageEntry[]>(
      path.join(this.baseDir, "messages.json"),
      [],
    );
  }

  async save(): Promise<void> {
    await ensureDir(this.baseDir);
    await writeJson(
      path.join(this.baseDir, "messages.json"),
      this.messages,
    );
  }

  push(from: string, to: string, message: string): void {
    this.messages.push({
      from,
      to,
      message,
      timestamp: Date.now(),
      acked: false,
    });
  }

  read(
    member: string,
    limit?: number,
    ack?: boolean,
  ): Array<{ from: string; message: string; time: string }> {
    const unread = this.messages.filter(
      (m) => m.to === member && !m.acked,
    );

    const slice = limit && limit > 0 ? unread.slice(0, limit) : unread;

    if (ack) {
      for (const msg of slice) {
        msg.acked = true;
      }
    }

    return slice.map((m) => ({
      from: m.from,
      message: m.message,
      time: new Date(m.timestamp).toISOString(),
    }));
  }

  clear(): void {
    this.messages = [];
  }
}

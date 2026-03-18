/**
 * Simple per-member message queue with persistence.
 *
 * Messages are stored per-recipient for efficient retrieval.
 */

import type { MessageEntry } from "../types.js";
import { readJson, writeJson, ensureDir } from "./persistence.js";
import * as path from "node:path";

const DEFAULT_MAX_MESSAGES = 1000;

export class MessageStore {
  private messages: MessageEntry[] = [];
  private baseDir: string;
  private maxMessages: number;

  constructor(baseDir: string, maxMessages?: number) {
    this.baseDir = baseDir;
    this.maxMessages = maxMessages ?? DEFAULT_MAX_MESSAGES;
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

    // Auto-trim oldest acked messages when exceeding limit
    if (this.messages.length > this.maxMessages) {
      this.trimAcked();
    }
  }

  private trimAcked(): void {
    // Remove oldest acked messages first to stay within bounds
    const excess = this.messages.length - this.maxMessages;
    if (excess <= 0) return;

    let removed = 0;
    this.messages = this.messages.filter((m) => {
      if (removed >= excess) return true;
      if (m.acked) {
        removed++;
        return false;
      }
      return true;
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

/**
 * Ring-buffer event queue with topic pub/sub.
 *
 * Events are appended to a fixed-capacity ring buffer. When the buffer
 * exceeds `maxBacklog`, the oldest entries are trimmed from the front.
 */

import type { EventEntry, EventQueueConfig } from "../types.js";
import { readJson, writeJson } from "./persistence.js";

const DEFAULT_MAX_BACKLOG = 500;

export class EventQueue {
  private events: EventEntry[] = [];
  private persistPath: string;
  private maxBacklog: number;
  private counter = 0;

  constructor(persistPath: string, config?: EventQueueConfig) {
    this.persistPath = persistPath;
    this.maxBacklog = config?.max_backlog ?? DEFAULT_MAX_BACKLOG;
  }

  // ── Disk I/O ────────────────────────────────────────────────────────

  async load(): Promise<void> {
    this.events = await readJson<EventEntry[]>(this.persistPath, []);

    // Restore counter from highest existing id
    for (const ev of this.events) {
      const num = parseInt(ev.id.replace("ev-", ""), 10);
      if (!isNaN(num) && num >= this.counter) {
        this.counter = num + 1;
      }
    }
  }

  async save(): Promise<void> {
    await writeJson(this.persistPath, this.events);
  }

  // ── Pub / Sub ───────────────────────────────────────────────────────

  publish(topic: string, from: string, message: string, data?: unknown): string {
    const entry: EventEntry = {
      id: this.nextId(),
      topic,
      from,
      message,
      ...(data !== undefined ? { data } : {}),
      timestamp: Date.now(),
    };

    this.events.push(entry);

    // Trim ring buffer from the front (oldest)
    if (this.events.length > this.maxBacklog) {
      const excess = this.events.length - this.maxBacklog;
      this.events.splice(0, excess);
    }

    return entry.id;
  }

  /**
   * Read events from a topic. Alias for `subscribe()`.
   */
  read(topic: string, since?: number, limit?: number): Array<{ id: string; from: string; message: string; data?: unknown; timestamp: number }> {
    return this.subscribe(topic, since, limit);
  }

  subscribe(topic: string, since?: string | number, limit?: number): EventEntry[] {
    let filtered: EventEntry[];

    // Filter by topic ("*" matches everything)
    if (topic === "*") {
      filtered = this.events;
    } else {
      filtered = this.events.filter((e) => e.topic === topic);
    }

    // Filter by `since` — either a timestamp (number) or event id (string)
    if (since != null) {
      if (typeof since === "number") {
        filtered = filtered.filter((e) => e.timestamp > since);
      } else {
        // Find the index of the event with this id, return everything after it
        const idx = filtered.findIndex((e) => e.id === since);
        if (idx !== -1) {
          filtered = filtered.slice(idx + 1);
        }
        // If id not found, return all matching (caller had a stale cursor)
      }
    }

    // Apply limit
    if (limit != null && limit > 0) {
      filtered = filtered.slice(-limit);
    }

    return filtered;
  }

  getTopics(): string[] {
    const topics = new Set<string>();
    for (const ev of this.events) {
      topics.add(ev.topic);
    }
    return Array.from(topics).sort();
  }

  clear(): void {
    this.events = [];
    // Intentionally do NOT reset counter — ids should never repeat
  }

  // ── Internal ────────────────────────────────────────────────────────

  private nextId(): string {
    return `ev-${this.counter++}`;
  }
}

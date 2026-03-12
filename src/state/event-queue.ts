/**
 * Ring-buffer event queue with topic pub/sub.
 *
 * Events are appended to a fixed-capacity ring buffer. When the buffer
 * exceeds `maxBacklog`, the oldest entries are trimmed from the front.
 */

import type { EventEntry, EventQueueConfig } from "../types.js";
import { readJson, writeJson } from "./persistence.js";
import { restoreCounter } from "../tools/tool-helpers.js";

const DEFAULT_MAX_BACKLOG = 500;

export class EventQueue {
  private events: EventEntry[] = [];
  private startIndex = 0;
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
    this.counter = restoreCounter(this.events, "ev-");

    // Seed counter from timestamp if no events exist to avoid restart collision
    if (this.events.length === 0 && this.counter === 0) {
      this.counter = Date.now() % 1_000_000;
    }
  }

  async save(): Promise<void> {
    // Compact on save — drop entries before startIndex
    if (this.startIndex > 0) {
      this.events = this.events.slice(this.startIndex);
      this.startIndex = 0;
    }
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

    // Trim ring buffer from the front (oldest) using start pointer
    const activeLength = this.events.length - this.startIndex;
    if (activeLength > this.maxBacklog) {
      this.startIndex = this.events.length - this.maxBacklog;
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

    // Filter by topic ("*" matches everything), iterating from startIndex
    if (topic === "*") {
      filtered = this.activeEvents();
    } else {
      filtered = this.activeEvents().filter((e) => e.topic === topic);
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
    for (let i = this.startIndex; i < this.events.length; i++) {
      topics.add(this.events[i]!.topic);
    }
    return Array.from(topics).sort();
  }

  clear(): void {
    this.events = [];
    this.startIndex = 0;
    // Intentionally do NOT reset counter — ids should never repeat
  }

  // ── Internal ────────────────────────────────────────────────────────

  /** Return active events (from startIndex onward). Only allocates on first call per mutation. */
  private activeEvents(): EventEntry[] {
    return this.startIndex === 0 ? this.events : this.events.slice(this.startIndex);
  }

  private nextId(): string {
    return `ev-${this.counter++}`;
  }
}

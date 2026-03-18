/**
 * Real-time broadcast.jsonl event watcher.
 *
 * Uses fs.watch() to detect appends and resolves promises
 * when matching events arrive. Supports progressive assertion
 * patterns for E2E tests.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ActivityType, BroadcastEvent } from "../../../src/types.js";

interface PendingResolver {
  filter: (event: BroadcastEvent) => boolean;
  resolve: (event: BroadcastEvent) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingMultiResolver {
  filter: (event: BroadcastEvent) => boolean;
  count: number;
  collected: BroadcastEvent[];
  resolve: (events: BroadcastEvent[]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class EventWatcher {
  private events: BroadcastEvent[] = [];
  private pendingResolvers: PendingResolver[] = [];
  private pendingMultiResolvers: PendingMultiResolver[] = [];
  private offset = 0;
  private watcher: fs.FSWatcher | null = null;
  private dirWatcher: fs.FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private broadcastPath: string;
  private closed = false;

  constructor(broadcastPath: string) {
    this.broadcastPath = broadcastPath;
    this.startWatching();
    // Polling fallback: fs.watch (kqueue on macOS) can miss rapid appends
    this.pollTimer = setInterval(() => {
      if (!this.closed) this.readNewLines();
    }, 1_000);
  }

  private startWatching(): void {
    // If the file exists, start watching it directly
    if (fs.existsSync(this.broadcastPath)) {
      this.readNewLines();
      this.watchFile();
    } else {
      // Watch the parent directory for file creation
      this.watchDir();
    }
  }

  private watchFile(): void {
    if (this.closed) return;
    try {
      this.watcher = fs.watch(this.broadcastPath, () => {
        if (!this.closed) this.readNewLines();
      });
      this.watcher.on("error", () => {
        // File may have been rotated or deleted; try to re-watch
      });
    } catch {
      // File may not exist yet
    }
  }

  private watchDir(): void {
    if (this.closed) return;
    const dir = path.dirname(this.broadcastPath);
    const filename = path.basename(this.broadcastPath);

    try {
      // Ensure parent directory exists
      fs.mkdirSync(dir, { recursive: true });

      this.dirWatcher = fs.watch(dir, (eventType, changedFile) => {
        if (changedFile === filename && fs.existsSync(this.broadcastPath)) {
          // File was created, switch to file watching
          this.dirWatcher?.close();
          this.dirWatcher = null;
          this.readNewLines();
          this.watchFile();
        }
      });
    } catch {
      // Directory watch failure is non-fatal
    }
  }

  private readNewLines(): void {
    try {
      const stat = fs.statSync(this.broadcastPath);
      if (stat.size <= this.offset) return;

      const fd = fs.openSync(this.broadcastPath, "r");
      try {
        const buf = Buffer.alloc(stat.size - this.offset);
        fs.readSync(fd, buf, 0, buf.length, this.offset);
        this.offset = stat.size;

        const chunk = buf.toString("utf-8");
        for (const line of chunk.split("\n")) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line) as BroadcastEvent;
            this.events.push(event);
            this.checkResolvers(event);
          } catch {
            // skip malformed lines
          }
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // File may not exist yet or is being written to
    }
  }

  private checkResolvers(event: BroadcastEvent): void {
    // Check single-event resolvers
    for (let i = this.pendingResolvers.length - 1; i >= 0; i--) {
      const resolver = this.pendingResolvers[i];
      if (resolver.filter(event)) {
        clearTimeout(resolver.timer);
        this.pendingResolvers.splice(i, 1);
        resolver.resolve(event);
      }
    }

    // Check multi-event resolvers
    for (let i = this.pendingMultiResolvers.length - 1; i >= 0; i--) {
      const resolver = this.pendingMultiResolvers[i];
      if (resolver.filter(event)) {
        resolver.collected.push(event);
        if (resolver.collected.length >= resolver.count) {
          clearTimeout(resolver.timer);
          this.pendingMultiResolvers.splice(i, 1);
          resolver.resolve(resolver.collected);
        }
      }
    }
  }

  /**
   * Wait for a specific event type. Resolves immediately if already buffered.
   */
  async expectEvent(
    type: ActivityType,
    opts?: { timeout?: number; match?: (event: BroadcastEvent) => boolean },
  ): Promise<BroadcastEvent> {
    const timeout = opts?.timeout ?? 60_000;
    const matchFn = opts?.match ?? (() => true);

    // Check buffered events first
    const existing = this.events.find(
      (e) => e.type === type && matchFn(e),
    );
    if (existing) return existing;

    return new Promise<BroadcastEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.pendingResolvers.findIndex((r) => r.timer === timer);
        if (idx !== -1) this.pendingResolvers.splice(idx, 1);
        reject(
          new Error(
            `Timed out waiting for event "${type}" after ${timeout}ms. ` +
              `Events seen: [${this.events.map((e) => e.type).join(", ")}]`,
          ),
        );
      }, timeout);

      this.pendingResolvers.push({
        filter: (e) => e.type === type && matchFn(e),
        resolve,
        reject,
        timer,
      });
    });
  }

  /**
   * Wait for N events of a type, with optional match filter.
   */
  async expectEvents(
    type: ActivityType,
    count: number,
    opts?: { timeout?: number; match?: (event: BroadcastEvent) => boolean },
  ): Promise<BroadcastEvent[]> {
    const timeout = opts?.timeout ?? 60_000;
    const matchFn = opts?.match ?? (() => true);
    const filterFn = (e: BroadcastEvent) => e.type === type && matchFn(e);

    // Check buffered events first
    const existing = this.events.filter(filterFn);
    if (existing.length >= count) return existing.slice(0, count);

    return new Promise<BroadcastEvent[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.pendingMultiResolvers.findIndex(
          (r) => r.timer === timer,
        );
        if (idx !== -1) this.pendingMultiResolvers.splice(idx, 1);
        const seen = this.events.filter(filterFn);
        reject(
          new Error(
            `Timed out waiting for ${count} "${type}" events after ${timeout}ms. ` +
              `Got ${seen.length}. Events seen: [${this.events.map((e) => e.type).join(", ")}]`,
          ),
        );
      }, timeout);

      this.pendingMultiResolvers.push({
        filter: filterFn,
        count,
        collected: [...existing],
        resolve,
        reject,
        timer,
      });
    });
  }

  /**
   * Wait for N ms of silence (no new events matching filter).
   * Each matching event resets the quiet timer.
   */
  async waitForQuiet(
    type: ActivityType,
    quietMs: number,
    opts?: { match?: (e: BroadcastEvent) => boolean },
  ): Promise<void> {
    const matchFn = opts?.match ?? (() => true);

    return new Promise<void>((resolve) => {
      let quietTimer = setTimeout(resolve, quietMs);

      const resolver: PendingResolver = {
        filter: (e) => {
          if (e.type === type && matchFn(e)) {
            // Reset the quiet timer — event arrived, restart waiting
            clearTimeout(quietTimer);
            quietTimer = setTimeout(() => {
              const idx = this.pendingResolvers.indexOf(resolver);
              if (idx !== -1) this.pendingResolvers.splice(idx, 1);
              resolve();
            }, quietMs);
            // Keep resolver.timer in sync so close() clears the active timer
            resolver.timer = quietTimer;
          }
          return false; // Never "resolve" via the normal path
        },
        resolve: () => {}, // unused — we resolve via the quiet timer
        reject: () => {},
        timer: quietTimer,
      };

      this.pendingResolvers.push(resolver);
    });
  }

  /**
   * Wait for N events matching ANY of the given types, with optional match filter.
   * Event-driven — no polling.
   */
  async expectEventsOfTypes(
    types: ActivityType[],
    count: number,
    opts?: { timeout?: number; match?: (event: BroadcastEvent) => boolean },
  ): Promise<BroadcastEvent[]> {
    const timeout = opts?.timeout ?? 60_000;
    const matchFn = opts?.match ?? (() => true);
    const typeSet = new Set<string>(types);
    const filterFn = (e: BroadcastEvent) => typeSet.has(e.type) && matchFn(e);

    const existing = this.events.filter(filterFn);
    if (existing.length >= count) return existing.slice(0, count);

    return new Promise<BroadcastEvent[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.pendingMultiResolvers.findIndex(
          (r) => r.timer === timer,
        );
        if (idx !== -1) this.pendingMultiResolvers.splice(idx, 1);
        const seen = this.events.filter(filterFn);
        reject(
          new Error(
            `Timed out waiting for ${count} events of types [${types.join(", ")}] after ${timeout}ms. ` +
              `Got ${seen.length}. Events seen: [${this.events.map((e) => e.type).join(", ")}]`,
          ),
        );
      }, timeout);

      this.pendingMultiResolvers.push({
        filter: filterFn,
        count,
        collected: [...existing],
        resolve,
        reject,
        timer,
      });
    });
  }

  /**
   * Get all buffered events of a specific type, with optional match filter.
   */
  getEventsOfType(
    type: ActivityType,
    match?: (e: BroadcastEvent) => boolean,
  ): BroadcastEvent[] {
    this.readNewLines();
    const matchFn = match ?? (() => true);
    return this.events.filter((e) => e.type === type && matchFn(e));
  }

  /** All events seen so far. */
  getEvents(): BroadcastEvent[] {
    // Do a final read to catch any events we might have missed
    this.readNewLines();
    return [...this.events];
  }

  /** Stop watching and clean up resources. */
  close(): void {
    this.closed = true;
    this.watcher?.close();
    this.dirWatcher?.close();
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.watcher = null;
    this.dirWatcher = null;
    this.pollTimer = null;

    // Reject any remaining pending resolvers
    for (const resolver of this.pendingResolvers) {
      clearTimeout(resolver.timer);
      resolver.reject(new Error("EventWatcher closed"));
    }
    this.pendingResolvers = [];

    for (const resolver of this.pendingMultiResolvers) {
      clearTimeout(resolver.timer);
      resolver.reject(new Error("EventWatcher closed"));
    }
    this.pendingMultiResolvers = [];
  }
}

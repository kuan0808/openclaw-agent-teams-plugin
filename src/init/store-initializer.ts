/**
 * Initialize per-team state stores and broadcaster.
 */

import * as path from "node:path";
import type { AgentTeamsConfig } from "../types.js";
import type { TeamStores } from "../registry.js";
import { KvStore } from "../state/kv-store.js";
import { EventQueue } from "../state/event-queue.js";
import { DocPool } from "../state/doc-pool.js";
import { RunManager } from "../state/run-manager.js";
import { MessageStore } from "../state/message-store.js";
import { ActivityLog } from "../state/activity-log.js";
import { Broadcaster } from "../broadcast.js";
import { ensureDir } from "../state/persistence.js";

/**
 * Initialize broadcaster and all per-team stores.
 * The broadcaster is wired internally to each activity log.
 */
export async function initTeamStores(
  config: AgentTeamsConfig,
  stateDir: string,
  log: { info: (msg: string) => void },
): Promise<Map<string, TeamStores>> {
  // Initialize broadcaster
  const broadcastPath = path.join(stateDir, "broadcast.jsonl");
  const broadcaster = new Broadcaster(broadcastPath);
  await broadcaster.init();

  const teamsMap = new Map<string, TeamStores>();

  for (const [teamName, teamConfig] of Object.entries(config.teams)) {
    const kvPath = path.join(stateDir, "kv", `${teamName}.json`);
    const eventsPath = path.join(stateDir, "events", `${teamName}.json`);
    const docsDir = path.join(stateDir, "docs", teamName);
    const runsDir = path.join(stateDir, "runs", teamName);
    const messagesDir = path.join(stateDir, "messages", teamName);
    const activityDir = path.join(stateDir, "activity", teamName);

    const storeConfig = teamConfig.shared_memory?.stores;

    const kv = new KvStore(kvPath, storeConfig?.kv);
    const events = new EventQueue(eventsPath, storeConfig?.events);
    const docs = new DocPool(docsDir, storeConfig?.docs);
    const runs = new RunManager(runsDir);
    const messages = new MessageStore(messagesDir);
    const activity = new ActivityLog(activityDir);

    // Wire broadcaster to activity log
    activity.onEntry((entry) => broadcaster.emit(entry));

    // Load persisted state
    await Promise.all([
      kv.load(),
      events.load(),
      docs.load(),
      runs.load(),
      messages.load(),
      activity.load(),
    ]);

    teamsMap.set(teamName, { kv, events, docs, runs, messages, activity });
    log.info(`Team "${teamName}" stores initialized (including activity log).`);
  }

  return teamsMap;
}

/**
 * Read & assert on plugin state files.
 *
 * All readers use fs.readFileSync — state files are small JSON.
 * Types are reused from the plugin's own src/types.ts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type {
  TeamRun,
  ActivityEntry,
  KvEntry,
  MessageEntry,
  DocEntry,
  BroadcastEvent,
} from "../../../src/types.js";

/** Base path for plugin state, configurable via env var. */
const PLUGIN_DIR =
  process.env.AGENT_TEAMS_STATE_DIR ??
  path.join(os.homedir(), ".openclaw", "plugins", "agent-teams");

export function getPluginDir(): string {
  return PLUGIN_DIR;
}

export function getBroadcastPath(): string {
  return path.join(PLUGIN_DIR, "broadcast.jsonl");
}

/** Read the current run state for a team. Returns null if no run file exists. */
export function readRunState(team: string): TeamRun | null {
  const filePath = path.join(PLUGIN_DIR, "runs", team, "current.json");
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content) as TeamRun;
  } catch {
    return null;
  }
}

/** Read the activity log for a team. Returns empty array if no file exists. */
export function readActivity(team: string): ActivityEntry[] {
  const filePath = path.join(PLUGIN_DIR, "activity", team, "activity.json");
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content) as ActivityEntry[];
  } catch {
    return [];
  }
}

/** Read the KV store for a team. Returns empty array if no file exists. */
export function readKv(team: string): KvEntry[] {
  const filePath = path.join(PLUGIN_DIR, "kv", `${team}.json`);
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content) as KvEntry[];
  } catch {
    return [];
  }
}

/** Read messages for a team. Returns empty array if no file exists. */
export function readMessages(team: string): MessageEntry[] {
  const filePath = path.join(PLUGIN_DIR, "messages", team, "messages.json");
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content) as MessageEntry[];
  } catch {
    return [];
  }
}

/** Read the doc pool index for a team. Returns empty array if no file exists. */
export function readDocs(team: string): DocEntry[] {
  const filePath = path.join(PLUGIN_DIR, "docs", team, "_index.json");
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content) as DocEntry[];
  } catch {
    return [];
  }
}

/** Read all broadcast events. Returns empty array if no file exists. */
export function readBroadcast(): BroadcastEvent[] {
  const filePath = getBroadcastPath();
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const events: BroadcastEvent[] = [];
    for (const line of content.trim().split("\n")) {
      if (!line) continue;
      try {
        events.push(JSON.parse(line) as BroadcastEvent);
      } catch {
        // skip malformed lines
      }
    }
    return events;
  } catch {
    return [];
  }
}

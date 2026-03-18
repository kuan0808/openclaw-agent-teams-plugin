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

/**
 * Read the most recent run state for a team.
 * Checks active runs first, then falls back to archived runs.
 * Returns null if no run file exists.
 */
export function readRunState(team: string): TeamRun | null {
  const runsBase = path.join(PLUGIN_DIR, "runs", team);

  // Per-run layout: runs/<team>/active/<runId>.json and runs/<team>/archive/<runId>.json
  // Check both directories, return the most recently started run
  let latest: TeamRun | null = null;

  for (const subdir of ["active", "archive"]) {
    const dir = path.join(runsBase, subdir);
    try {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(dir, file), "utf-8");
          const run = JSON.parse(content) as TeamRun;
          if (!latest || run.started_at > latest.started_at) {
            latest = run;
          }
        } catch { /* skip malformed files */ }
      }
    } catch { /* dir may not exist */ }
  }

  if (latest) return latest;

  // Fallback: legacy single-file layout
  const legacyPath = path.join(runsBase, "current.json");
  try {
    const content = fs.readFileSync(legacyPath, "utf-8");
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

/** OpenClaw session transcript base directory. */
const SESSIONS_DIR = path.join(os.homedir(), ".openclaw", "agents", "main", "sessions");

/**
 * Read a main agent session transcript.
 * Returns parsed JSONL entries, or empty array if file missing.
 */
export function readMainAgentTranscript(sessionId: string): Record<string, unknown>[] {
  const filePath = path.join(SESSIONS_DIR, `${sessionId}.jsonl`);
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const entries: Record<string, unknown>[] = [];
    for (const line of content.trim().split("\n")) {
      if (!line) continue;
      try {
        entries.push(JSON.parse(line) as Record<string, unknown>);
      } catch { /* skip malformed */ }
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Find system notification messages in a session transcript that match a team prefix.
 * System events from `enqueueSystemEvent` appear as entries containing `[<team> Team]`.
 */
export function findSystemNotifications(sessionId: string, team: string): string[] {
  const transcript = readMainAgentTranscript(sessionId);
  const prefix = `[${team} Team]`;
  const notifications: string[] = [];
  for (const entry of transcript) {
    const text = typeof entry.text === "string" ? entry.text
      : typeof entry.message === "string" ? entry.message
      : "";
    if (text.includes(prefix)) {
      notifications.push(text);
    }
  }
  return notifications;
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

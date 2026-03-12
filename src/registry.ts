/**
 * Global singleton registry for accessing stores across tools/hooks.
 */

import type { KvStore } from "./state/kv-store.js";
import type { EventQueue } from "./state/event-queue.js";
import type { DocPool } from "./state/doc-pool.js";
import type { RunManager } from "./state/run-manager.js";
import type { MessageStore } from "./state/message-store.js";
import type { ActivityLog } from "./state/activity-log.js";
import type { AgentTeamsConfig, TeamConfig, RunSession } from "./types.js";
import type { CliSpawner } from "./cli/cli-spawner.js";

export interface TeamStores {
  kv: KvStore;
  events: EventQueue;
  docs: DocPool;
  runs: RunManager;
  messages: MessageStore;
  activity: ActivityLog;
}

export interface PluginRegistry {
  config: AgentTeamsConfig;
  teams: Map<string, TeamStores>;

  // ── Per-run session tracking ──────────────────────────────────────
  // Replaces the old 1:1 sessions/sessionToAgent maps.
  // Each agent can have multiple concurrent run sessions.
  memberSessions: Map<string, Map<string, RunSession>>;   // agentId -> Map<runId, RunSession>
  sessionIndex: Map<string, { agentId: string; runId: string }>;  // sessionKey -> { agentId, runId }

  // ── Legacy 1:1 session tracking (fallback spawn path only) ────────
  sessions: Map<string, string>;           // agentId -> sessionKey (spawn path)
  sessionToAgent: Map<string, string>;     // sessionKey -> agentId (spawn path reverse)

  getTeamStores(team: string): TeamStores | undefined;
  getTeamConfig(team: string): TeamConfig | undefined;
  enqueueSystemEvent: (text: string, options: { sessionKey: string }) => boolean;
  requestHeartbeatNow: (opts?: { reason?: string; agentId?: string; sessionKey?: string }) => void;
  cliSpawner?: CliSpawner;
}

let _registry: PluginRegistry | null = null;

export function setRegistry(reg: PluginRegistry): void {
  _registry = reg;
}

export function getRegistry(): PluginRegistry {
  if (!_registry) throw new Error("Agent Teams plugin not initialized");
  return _registry;
}

// ── Per-run session helpers ──────────────────────────────────────────

/**
 * Register a per-run session in the registry's memberSessions and sessionIndex.
 */
export function registerRunSession(
  registry: PluginRegistry,
  agentId: string,
  runId: string,
  sessionKey: string,
  createdAt: number,
): void {
  if (!registry.memberSessions.has(agentId)) {
    registry.memberSessions.set(agentId, new Map());
  }
  const agentSessions = registry.memberSessions.get(agentId)!;
  agentSessions.set(runId, { sessionKey, runId, createdAt });
  registry.sessionIndex.set(sessionKey, { agentId, runId });
}

/**
 * Resolve the best session key for an agent.
 * Priority: per-run session (for specific runId) → legacy session.
 */
export function resolveAgentSession(
  registry: PluginRegistry,
  agentId: string,
  runId?: string,
): string | undefined {
  const runSessions = registry.memberSessions.get(agentId);
  if (runSessions) {
    if (runId) {
      const rs = runSessions.get(runId);
      if (rs) return rs.sessionKey;
    }
    // No specific runId: pick the most recently created session
    let latest: RunSession | undefined;
    for (const rs of runSessions.values()) {
      if (!latest || rs.createdAt > latest.createdAt) {
        latest = rs;
      }
    }
    if (latest) return latest.sessionKey;
  }
  // Fall back to legacy session
  return registry.sessions.get(agentId);
}

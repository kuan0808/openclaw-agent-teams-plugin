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
  // Each agent can have multiple concurrent run sessions.
  memberSessions: Map<string, Map<string, RunSession>>;   // agentId -> Map<runId, RunSession>
  sessionIndex: Map<string, { agentId: string; runId: string }>;  // sessionKey -> { agentId, runId }

  // Sessions explicitly invalidated by run cancellation/completion.
  // Used by checkSessionStillActive to reject tool calls from stale agents.
  invalidatedSessions: Set<string>;

  getTeamStores(team: string): TeamStores | undefined;
  getTeamConfig(team: string): TeamConfig | undefined;
  enqueueSystemEvent: (text: string, options: { sessionKey: string }) => boolean;
  requestHeartbeatNow: (opts?: { reason?: string; agentId?: string; sessionKey?: string }) => void;
  cliSpawner?: CliSpawner;
  ensureCliReady?: () => Promise<void>;
}

let _registry: PluginRegistry | null = null;

export function setRegistry(reg: PluginRegistry): void {
  _registry = reg;
}

export function getRegistry(): PluginRegistry {
  if (!_registry) throw new Error("Agent Teams plugin not initialized");
  return _registry;
}

/**
 * Safe variant — returns null instead of throwing when not initialized.
 * Used in fire-and-forget contexts (crash handlers, notifications).
 */
export function tryGetRegistry(): PluginRegistry | null {
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
 * Clean up all session registry entries for a given runId.
 * Used after archiving a completed/canceled run.
 */
const MAX_INVALIDATED_SESSIONS = 500;

export function cleanupRunSessions(registry: PluginRegistry, runId: string): void {
  for (const [agentId, agentSessions] of registry.memberSessions) {
    const session = agentSessions.get(runId);
    if (session) {
      registry.invalidatedSessions.add(session.sessionKey);
      registry.sessionIndex.delete(session.sessionKey);
      agentSessions.delete(runId);
      if (agentSessions.size === 0) registry.memberSessions.delete(agentId);
    }
  }
  // Prevent unbounded growth: trim oldest entries when cap exceeded.
  if (registry.invalidatedSessions.size > MAX_INVALIDATED_SESSIONS) {
    const excess = registry.invalidatedSessions.size - MAX_INVALIDATED_SESSIONS;
    let removed = 0;
    for (const key of registry.invalidatedSessions) {
      if (removed >= excess) break;
      registry.invalidatedSessions.delete(key);
      removed++;
    }
  }
}

/**
 * Resolve the best session key for an agent.
 * Looks up per-run sessions by runId, or picks the most recent one.
 */
export function resolveAgentSession(
  registry: PluginRegistry,
  agentId: string,
  runId?: string,
): string | undefined {
  const runSessions = registry.memberSessions.get(agentId);
  if (!runSessions) return undefined;

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
  return latest?.sessionKey;
}

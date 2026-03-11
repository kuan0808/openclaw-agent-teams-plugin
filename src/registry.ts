/**
 * Global singleton registry for accessing stores across tools/hooks.
 */

import type { KvStore } from "./state/kv-store.js";
import type { EventQueue } from "./state/event-queue.js";
import type { DocPool } from "./state/doc-pool.js";
import type { RunManager } from "./state/run-manager.js";
import type { MessageStore } from "./state/message-store.js";
import type { ActivityLog } from "./state/activity-log.js";
import type { AgentTeamsConfig, TeamConfig } from "./types.js";
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
  sessions: Map<string, string>; // agentId (at--team--member) -> sessionKey
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

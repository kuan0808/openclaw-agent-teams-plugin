/**
 * OpenClaw Agent Teams Plugin
 *
 * Declarative multi-agent team coordination with Orchestrator and Peer patterns.
 * Provides team_run, team_task, team_memory, team_send, team_inbox tools,
 * lifecycle hooks, and /team quick commands.
 *
 * Enhanced with:
 *  - Activity logging & audit trail
 *  - Deliverables registration
 *  - Approval/verification gates
 *  - Enhanced learning system (auto-capture + structured + prioritized)
 *  - File-based event broadcasting (.jsonl)
 *  - Workflow templates with fail-loopback
 *  - Timeout & max_rounds enforcement
 *  - Peer auto-complete & cascade cancel
 */

import * as path from "node:path";

import { validateConfig, parseConfig } from "./src/config.js";
import { setRegistry, type PluginRegistry, type TeamStores } from "./src/registry.js";
import type { AgentTeamsConfig, RunSession } from "./src/types.js";
import { isCliMember } from "./src/types.js";
import { ensureDir } from "./src/state/persistence.js";
import { reconcileHostRuntimeConfig } from "./src/setup/runtime-compat.js";
import {
  provisionAgents,
  injectAgents,
  createWorkspaces,
  collectAllAgentIds,
} from "./src/setup/agent-provisioner.js";

// Init modules
import { registerPluginSurface } from "./src/init/plugin-registrar.js";
import { initTeamStores } from "./src/init/store-initializer.js";
import { createLazyCliInit } from "./src/init/cli-initializer.js";
import { recoverRunSessions } from "./src/init/session-recovery.js";

// ── Module-level singletons ──────────────────────────────────────────────
// These survive gateway re-activations within the same process. The gateway
// calls activate() multiple times during startup; each call builds a fresh
// registry wrapper but wraps the SAME underlying Maps and stores.

let _teamsMap: Map<string, TeamStores> | null = null;
let _memberSessions: Map<string, Map<string, RunSession>> | null = null;
let _sessionIndex: Map<string, { agentId: string; runId: string }> | null = null;
let _storesInitialized = false;
let _activationInFlight: Promise<void> | null = null;

// ── Plugin Definition ────────────────────────────────────────────────────

interface PluginApi {
  id: string;
  name: string;
  config: Record<string, any>;
  pluginConfig?: Record<string, unknown>;
  runtime: {
    system: {
      enqueueSystemEvent: (text: string, options: { sessionKey: string }) => boolean;
      requestHeartbeatNow: (opts?: { reason?: string; agentId?: string; sessionKey?: string }) => void;
    };
    state: {
      resolveStateDir: () => string;
    };
  };
  logger: {
    debug?: (message: string) => void;
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
  };
  registerTool: (tool: any, opts?: any) => void;
  registerHook: (events: string | string[], handler: any, opts?: any) => void;
  registerCommand: (command: any) => void;
  on: (hookName: string, handler: any, opts?: { priority?: number }) => void;
}

export default {
  id: "agent-teams",
  name: "Agent Teams",
  description: "Declarative multi-agent team coordination with Orchestrator and Peer patterns",
  version: "1.0.0",

  async activate(api: PluginApi) {
    const log = api.logger;
    log.info("Agent Teams plugin activating...");

    // ── 1. Validate & parse config ──────────────────────────────────
    const rawConfig = api.pluginConfig ?? {};
    const validation = validateConfig(rawConfig);
    if (!validation.ok) {
      for (const err of validation.errors) {
        log.error(`Config error: ${err}`);
      }
      log.error(
        "Agent Teams plugin disabled due to config errors. " +
        "Use the agent-teams-setup skill for guided configuration, or see the README for config examples.",
      );
      return;
    }

    const config: AgentTeamsConfig = parseConfig(rawConfig);
    const teamNames = Object.keys(config.teams);

    if (teamNames.length === 0) {
      log.info(
        "No teams configured — Agent Teams plugin idle. " +
        'Say "help me set up a team" to start the guided setup.',
      );
      return;
    }

    log.info(`Configured teams: ${teamNames.join(", ")}`);

    // ── 2. Reconcile host runtime config ────────────────────────────
    const compat = reconcileHostRuntimeConfig(api.config, config);
    for (const change of compat.changes) log.info(change);
    for (const warning of compat.warnings) log.warn(warning);

    // ── 3. Synchronous registration (before first await) ────────────
    // Reuse module-level singletons so all activations share the same
    // Maps and stores. Fresh Maps only on first activation in a process.
    if (!_teamsMap) _teamsMap = new Map();
    if (!_memberSessions) _memberSessions = new Map();
    if (!_sessionIndex) _sessionIndex = new Map();

    const stateDir = path.join(
      api.runtime.state.resolveStateDir(),
      "plugins",
      "agent-teams",
    );

    const registry: PluginRegistry = {
      config,
      teams: _teamsMap,
      memberSessions: _memberSessions,
      sessionIndex: _sessionIndex,
      invalidatedSessions: new Set(),
      getTeamStores: (team: string) => _teamsMap!.get(team),
      getTeamConfig: (team: string) => config.teams[team],
      enqueueSystemEvent: api.runtime.system.enqueueSystemEvent,
      requestHeartbeatNow: api.runtime.system.requestHeartbeatNow as any,
    };
    setRegistry(registry);

    // ── 3b. Lazy CLI init
    const hasCliMembers = Object.values(config.teams).some((tc) =>
      Object.values(tc.members).some((m) => isCliMember(m)),
    );
    if (hasCliMembers) {
      registry.ensureCliReady = createLazyCliInit(config, stateDir, registry, log);
    }

    // Always re-register tools/hooks/commands — gateway may need them
    registerPluginSurface(api);

    // ── 3c. Provision & inject agents synchronously ──────────────────
    // CRITICAL: Gateway ignores the async portion of activate() — agent
    // injection MUST happen before the first await or agents won't appear
    // in the runtime config (and thus won't show in WebUI/agent list).
    const provisioned = provisionAgents(config, stateDir);
    const allAgentIds = collectAllAgentIds(config);
    const injected = injectAgents(api.config, provisioned, allAgentIds);
    if (injected.length > 0) {
      log.info(`Injected ${injected.length} team agents: ${injected.join(", ")}`);
    }

    // ── 4. Async: only initialize stores once per process ────────────
    if (_storesInitialized) {
      log.info("Agent Teams plugin re-activated (stores preserved in memory).");
      return;
    }

    // If another activation is already doing async init, wait for it
    if (_activationInFlight) {
      await _activationInFlight;
      log.info("Agent Teams plugin re-activated (stores initialized by prior activation).");
      return;
    }

    // First activation: load stores, recover sessions, create workspaces
    _activationInFlight = (async () => {
      await ensureDir(stateDir);

      // Clear any partial state from a prior failed activation attempt
      _teamsMap!.clear();

      const loadedTeams = await initTeamStores(config, stateDir, log);
      for (const [name, stores] of loadedTeams) {
        _teamsMap!.set(name, stores);
      }

      recoverRunSessions(_teamsMap!, registry);
      await createWorkspaces(provisioned);

      // CLI infra (IPC server + spawner) is initialized on-demand when the
      // first CLI agent needs to be spawned (via spawnCliIfNeeded → ensureCliReady).
      // Eager init is intentionally skipped to avoid starting a net.Server
      // during short-lived gateway CLI commands (restart/install/status),
      // which would keep the process alive and block the command from exiting.

      _storesInitialized = true;

      const featureFlags: string[] = [];
      for (const [teamName, teamConfig] of Object.entries(config.teams)) {
        if (teamConfig.workflow?.gates) featureFlags.push(`${teamName}:gates`);
        if (teamConfig.workflow?.template) featureFlags.push(`${teamName}:workflow-template`);
      }

      log.info(
        `Agent Teams plugin activated. ${teamNames.length} team(s), ` +
        `${provisioned.length} native agent(s)${hasCliMembers ? " + CLI agents (on-demand)" : ""}, ` +
        `5 tools, 4 hooks, 1 commands. ` +
        `Enhanced: activity-log, deliverables, learnings, broadcast, enforcement` +
        (hasCliMembers ? ", cli-agents" : "") +
        (featureFlags.length > 0 ? `, ${featureFlags.join(", ")}` : "") +
        `.`,
      );
    })();

    try {
      await _activationInFlight;
    } finally {
      _activationInFlight = null;
    }
  },
};

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
 */

import * as path from "node:path";

import { validateConfig, parseConfig } from "./src/config.js";
import { setRegistry, type PluginRegistry, type TeamStores } from "./src/registry.js";
import type { AgentTeamsConfig } from "./src/types.js";
import { isCliMember } from "./src/types.js";

// State stores
import { KvStore } from "./src/state/kv-store.js";
import { EventQueue } from "./src/state/event-queue.js";
import { DocPool } from "./src/state/doc-pool.js";
import { RunManager } from "./src/state/run-manager.js";
import { MessageStore } from "./src/state/message-store.js";
import { ActivityLog } from "./src/state/activity-log.js";
import { ensureDir } from "./src/state/persistence.js";

// Broadcasting
import { Broadcaster } from "./src/broadcast.js";

// Agent provisioning
import {
  provisionAgents,
  injectAgents,
  createWorkspaces,
  collectAllAgentIds,
} from "./src/setup/agent-provisioner.js";

// CLI agent support
import { IpcServer } from "./src/cli/ipc-server.js";
import { CliSpawner } from "./src/cli/cli-spawner.js";

// Hooks
import { createAgentStartHook } from "./src/hooks/agent-start.js";
import { createCompactionHook } from "./src/hooks/compaction.js";
import {
  createSubagentSpawnedHook,
  createSubagentEndedHook,
  createDeliveryTargetHook,
} from "./src/hooks/subagent-lifecycle.js";

// Tools
import { teamRunTool } from "./src/tools/team-run.js";
import { teamTaskTool } from "./src/tools/team-task.js";
import { teamMemoryTool } from "./src/tools/team-memory.js";
import { teamSendTool } from "./src/tools/team-send.js";
import { teamInboxTool } from "./src/tools/team-inbox.js";

// Commands
import { createTeamCommands } from "./src/commands/team-command.js";

// ── Plugin Definition ────────────────────────────────────────────────────

// Use an interface that matches the Plugin API shape, without importing
// the actual type (since openclaw is a peer dependency).
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
      log.error("Agent Teams plugin disabled due to config errors.");
      return;
    }

    const config: AgentTeamsConfig = parseConfig(rawConfig);
    const teamNames = Object.keys(config.teams);

    if (teamNames.length === 0) {
      log.info("No teams configured. Agent Teams plugin idle.");
      return;
    }

    log.info(`Configured teams: ${teamNames.join(", ")}`);

    // ── 2. Resolve state directory ──────────────────────────────────
    const stateDir = path.join(
      api.runtime.state.resolveStateDir(),
      "plugins",
      "agent-teams",
    );
    await ensureDir(stateDir);

    // ── 3. Initialize broadcaster ───────────────────────────────────
    const broadcastPath = path.join(stateDir, "broadcast.jsonl");
    const broadcaster = new Broadcaster(broadcastPath);
    await broadcaster.init();

    // ── 4. Initialize stores for each team ──────────────────────────
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

    // ── 5. Create and set global registry ───────────────────────────
    const registry: PluginRegistry = {
      config,
      teams: teamsMap,
      sessions: new Map(),
      getTeamStores: (team: string) => teamsMap.get(team),
      getTeamConfig: (team: string) => config.teams[team],
      enqueueSystemEvent: api.runtime.system.enqueueSystemEvent,
      requestHeartbeatNow: api.runtime.system.requestHeartbeatNow as any,
    };
    setRegistry(registry);

    // ── 6. Provision agents (in-memory injection) ───────────────────
    const provisioned = provisionAgents(config, stateDir);
    const allAgentIds = collectAllAgentIds(config);
    const injected = injectAgents(api.config, provisioned, allAgentIds);
    await createWorkspaces(provisioned);

    if (injected.length > 0) {
      log.info(`Injected ${injected.length} team agents: ${injected.join(", ")}`);
    }

    // ── 6b. Initialize CLI agent infrastructure ─────────────────────
    const hasCliMembers = Object.values(config.teams).some((tc) =>
      Object.values(tc.members).some((m) => isCliMember(m)),
    );

    let ipcServer: IpcServer | null = null;
    if (hasCliMembers) {
      const sockPath = path.join(stateDir, "ipc.sock");

      // Start IPC server
      ipcServer = new IpcServer(sockPath, registry);
      await ipcServer.start();
      log.info(`IPC server started at ${sockPath}`);

      // Initialize CLI spawner (on-demand, no agents spawned yet)
      const cliSpawner = new CliSpawner(stateDir, sockPath, registry);
      registry.cliSpawner = cliSpawner;

      // Cleanup on process exit (use 'once' to prevent accumulation on re-activation)
      const cleanup = () => {
        cliSpawner.killAll();
        ipcServer?.stop();
      };
      process.once("SIGINT", cleanup);
      process.once("SIGTERM", cleanup);

      const cliMemberCount = Object.values(config.teams).reduce((acc, tc) =>
        acc + Object.values(tc.members).filter((m) => isCliMember(m)).length, 0,
      );
      log.info(`CLI agent support enabled: ${cliMemberCount} CLI member(s) configured (on-demand spawn).`);
    }

    // ── 7. Register hooks ───────────────────────────────────────────
    api.on("before_agent_start", createAgentStartHook(), { priority: 10 });
    api.on("before_compaction", createCompactionHook(), { priority: 10 });
    api.on("subagent_spawned", createSubagentSpawnedHook(), { priority: 10 });
    api.on("subagent_ended", createSubagentEndedHook(), { priority: 10 });
    api.on("subagent_delivery_target", createDeliveryTargetHook(), { priority: 10 });
    // message_sending hook omitted — SDK's PluginHookMessageContext lacks agentId,
    // so delivery control is handled by subagent_delivery_target instead.

    // ── 8. Register tools (Factory pattern) ─────────────────────────
    api.registerTool((ctx: any) => {
      // Return all 5 tools for any agent that might interact with teams
      return [
        teamRunTool(ctx),
        teamTaskTool(ctx),
        teamMemoryTool(ctx),
        teamSendTool(ctx),
        teamInboxTool(ctx),
      ];
    });

    // ── 9. Register /team commands ──────────────────────────────────
    const commands = createTeamCommands();
    for (const cmd of commands) {
      api.registerCommand({
        name: cmd.name,
        description: cmd.description,
        acceptsArgs: cmd.acceptsArgs,
        requireAuth: cmd.requireAuth,
        handler: cmd.handler,
      });
    }

    // ── 10. Log feature summary ─────────────────────────────────────
    const featureFlags: string[] = [];
    for (const [teamName, teamConfig] of Object.entries(config.teams)) {
      if (teamConfig.workflow?.gates) featureFlags.push(`${teamName}:gates`);
      if (teamConfig.workflow?.template) featureFlags.push(`${teamName}:workflow-template`);
    }

    const commandCount = hasCliMembers ? 7 : 3;
    log.info(
      `Agent Teams plugin activated. ${teamNames.length} team(s), ` +
      `${provisioned.length} native agent(s)${hasCliMembers ? " + CLI agents (on-demand)" : ""}, ` +
      `5 tools, 5 hooks, ${commandCount} commands. ` +
      `Enhanced: activity-log, deliverables, learnings, broadcast` +
      (hasCliMembers ? ", cli-agents" : "") +
      (featureFlags.length > 0 ? `, ${featureFlags.join(", ")}` : "") +
      `.`,
    );
  },
};

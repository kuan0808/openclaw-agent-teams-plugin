/**
 * Register hooks, tools, and commands on the plugin API.
 *
 * Must be called synchronously (before first await) per OpenClaw requirement.
 */

import { createAgentStartHook } from "../hooks/agent-start.js";
import { createCompactionHook } from "../hooks/compaction.js";
import {
  createSubagentEndedHook,
  createDeliveryTargetHook,
} from "../hooks/subagent-lifecycle.js";
import { teamRunTool } from "../tools/team-run.js";
import { teamTaskTool } from "../tools/team-task.js";
import { teamMemoryTool } from "../tools/team-memory.js";
import { teamSendTool } from "../tools/team-send.js";
import { teamInboxTool } from "../tools/team-inbox.js";
import { createTeamCommands } from "../commands/team-command.js";

interface PluginApiSurface {
  registerTool: (tool: any, opts?: any) => void;
  registerCommand: (command: any) => void;
  on: (hookName: string, handler: any, opts?: { priority?: number }) => void;
}

/**
 * Register all hooks, tools, and commands synchronously.
 */
export function registerPluginSurface(api: PluginApiSurface): void {
  // Hooks
  api.on("before_agent_start", createAgentStartHook(), { priority: 10 });
  api.on("before_compaction", createCompactionHook(), { priority: 10 });
  api.on("subagent_ended", createSubagentEndedHook(), { priority: 10 });
  api.on("subagent_delivery_target", createDeliveryTargetHook(), { priority: 10 });

  // Tools
  api.registerTool((ctx: any) => {
    return [
      teamRunTool(ctx),
      teamTaskTool(ctx),
      teamMemoryTool(ctx),
      teamSendTool(ctx),
      teamInboxTool(ctx),
    ];
  });

  // Commands
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
}

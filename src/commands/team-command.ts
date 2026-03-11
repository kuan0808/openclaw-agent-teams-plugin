/**
 * Quick commands for team management.
 *
 * Registered as /team with subcommands: status, stop, list, agents, logs, start, stop-agent.
 */

import { getRegistry } from "../registry.js";
import { makeAgentId, isCliMember, getCliCwd } from "../types.js";
import { buildSystemPrompt } from "../cli/prompt-builder.js";
import type { TeamRun, TeamTask, TaskState } from "../types.js";

// ── Types ─────────────────────────────────────────────────────────────────

export interface TeamCommandDef {
  name: string;
  description: string;
  acceptsArgs: boolean;
  requireAuth: boolean;
  handler: (ctx: {
    args?: string;
    config: any;
    senderId?: string;
    isAuthorizedSender: boolean;
  }) => { text?: string } | Promise<{ text?: string }>;
}

// ── Command factory ───────────────────────────────────────────────────────

export function createTeamCommands(): TeamCommandDef[] {
  return [
    {
      name: "team status",
      description: "Show current run progress, task board, and active members for a team.",
      acceptsArgs: true,
      requireAuth: false,
      handler: handleStatus,
    },
    {
      name: "team stop",
      description: "Cancel the current run for a team and notify members.",
      acceptsArgs: true,
      requireAuth: true,
      handler: handleStop,
    },
    {
      name: "team list",
      description: "List all defined teams with member count and run status.",
      acceptsArgs: false,
      requireAuth: false,
      handler: handleList,
    },
    {
      name: "team agents",
      description: "Show status of all CLI agents (running/stopped/exited).",
      acceptsArgs: false,
      requireAuth: false,
      handler: handleAgents,
    },
    {
      name: "team logs",
      description: "Print path to CLI agent log file for `tail -f` observation.",
      acceptsArgs: true,
      requireAuth: false,
      handler: handleLogs,
    },
    {
      name: "team start",
      description: "Manually spawn a CLI agent.",
      acceptsArgs: true,
      requireAuth: true,
      handler: handleStartAgent,
    },
    {
      name: "team stop-agent",
      description: "Kill a running CLI agent.",
      acceptsArgs: true,
      requireAuth: true,
      handler: handleStopAgent,
    },
  ];
}

// ── Handlers ──────────────────────────────────────────────────────────────

async function handleStatus(ctx: {
  args?: string;
  config: any;
  senderId?: string;
  isAuthorizedSender: boolean;
}): Promise<{ text?: string }> {
  const registry = getRegistry();
  const teamName = ctx.args?.trim();

  if (!teamName) {
    // Show all teams' status
    const lines: string[] = ["Teams Status:"];
    for (const [name, teamConfig] of Object.entries(registry.config.teams)) {
      const stores = registry.getTeamStores(name);
      const runResult = stores?.runs.getRun(name);
      const run = runResult?.found ? runResult.run : null;
      const status = run ? `${run.status} — ${run.goal.slice(0, 60)}` : "No active run";
      const cliCount = Object.values(teamConfig.members).filter((m) => isCliMember(m)).length;
      const cliLabel = cliCount > 0 ? `, ${cliCount} CLI` : "";
      lines.push(`\n${name} (${teamConfig.coordination}, ${Object.keys(teamConfig.members).length} members${cliLabel})`);
      lines.push(`  ${status}`);
      if (run) {
        lines.push(`  ${formatTaskCounts(run)}`);
      }
    }
    return { text: lines.join("\n") };
  }

  // Single team status
  const teamConfig = registry.getTeamConfig(teamName);
  if (!teamConfig) {
    return { text: `Team "${teamName}" not found.` };
  }

  const stores = registry.getTeamStores(teamName);
  if (!stores) {
    return { text: `No stores initialized for team "${teamName}".` };
  }

  const runResult = stores.runs.getRun(teamName);
  if (!runResult.found) {
    return {
      text: [
        `Team: ${teamName}`,
        `Mode: ${teamConfig.coordination}`,
        `Members: ${Object.keys(teamConfig.members).join(", ")}`,
        `Status: No active run`,
      ].join("\n"),
    };
  }

  const run = runResult.run;
  const lines: string[] = [
    `Team: ${teamName}`,
    `Run: ${run.id} (${run.status})`,
    `Goal: ${run.goal}`,
    `Started: ${new Date(run.started_at).toISOString()}`,
    ``,
    `Task Board:`,
  ];

  if (run.tasks.length === 0) {
    lines.push("  (no tasks)");
  } else {
    for (const task of run.tasks) {
      const assignee = task.assigned_to ? ` -> ${task.assigned_to}` : "";
      const deps = task.depends_on?.length ? ` [deps: ${task.depends_on.join(", ")}]` : "";
      lines.push(`  [${task.status}] ${task.id}${assignee}: ${task.description.slice(0, 70)}${deps}`);
    }
    lines.push("");
    lines.push(formatTaskCounts(run));
  }

  // Active members (those with WORKING tasks)
  const activeMembers = new Set(
    run.tasks
      .filter((t) => t.status === "WORKING" && t.assigned_to)
      .map((t) => t.assigned_to!),
  );
  if (activeMembers.size > 0) {
    lines.push(`Active members: ${[...activeMembers].join(", ")}`);
  }

  return { text: lines.join("\n") };
}

async function handleStop(ctx: {
  args?: string;
  config: any;
  senderId?: string;
  isAuthorizedSender: boolean;
}): Promise<{ text?: string }> {
  if (!ctx.isAuthorizedSender) {
    return { text: "Permission denied. Only authorized users can stop a team run." };
  }

  const registry = getRegistry();
  const teamName = ctx.args?.trim();

  if (!teamName) {
    return { text: "Usage: /team stop <team-name>" };
  }

  const stores = registry.getTeamStores(teamName);
  if (!stores) {
    return { text: `Team "${teamName}" not found.` };
  }

  const runResult = stores.runs.getRun(teamName);
  if (!runResult.found) {
    return { text: `No active run for team "${teamName}".` };
  }

  const run = runResult.run;
  if (run.status !== "WORKING") {
    return { text: `Run ${run.id} is already ${run.status}.` };
  }

  const reason = "Stopped by user command";
  const result = stores.runs.cancelRun(teamName, reason);
  stores.activity.log(teamName, "__command__", "run_canceled",
    `Run stopped by user command`, {
      metadata: { reason, tasks_canceled: result.tasks_canceled },
    });
  await Promise.all([stores.runs.save(), stores.activity.save()]);

  return {
    text: [
      `Run ${run.id} canceled.`,
      `Tasks canceled: ${result.tasks_canceled}`,
      `Reason: Stopped by user command`,
    ].join("\n"),
  };
}

async function handleList(ctx: {
  args?: string;
  config: any;
  senderId?: string;
  isAuthorizedSender: boolean;
}): Promise<{ text?: string }> {
  const registry = getRegistry();
  const teams = Object.entries(registry.config.teams);

  if (teams.length === 0) {
    return { text: "No teams configured." };
  }

  const lines: string[] = [`Configured Teams (${teams.length}):`];

  for (const [name, config] of teams) {
    const memberCount = Object.keys(config.members).length;
    const cliMembers = Object.entries(config.members)
      .filter(([, m]) => isCliMember(m))
      .map(([key, m]) => `${key}[${m.cli}]`);
    const stores = registry.getTeamStores(name);
    const runResult = stores?.runs.getRun(name);
    const runStatus = runResult?.found ? runResult.run.status : "idle";

    let line = `  ${name} — ${config.coordination} | ${memberCount} members | ${runStatus}`;
    if (cliMembers.length > 0) {
      line += ` | CLI: ${cliMembers.join(", ")}`;
    }
    lines.push(line);
  }

  return { text: lines.join("\n") };
}

async function handleAgents(): Promise<{ text?: string }> {
  const registry = getRegistry();
  const spawner = registry.cliSpawner;

  if (!spawner) {
    return { text: "No CLI agents configured." };
  }

  const processes = spawner.getAllProcesses();
  if (processes.size === 0) {
    // Show configured but not running
    const lines: string[] = ["CLI Agents:"];
    for (const [teamName, teamConfig] of Object.entries(registry.config.teams)) {
      for (const [memberKey, memberConfig] of Object.entries(teamConfig.members)) {
        if (isCliMember(memberConfig)) {
          lines.push(`  ${makeAgentId(teamName, memberKey)} [${memberConfig.cli}] — not started`);
        }
      }
    }
    return { text: lines.length === 1 ? "No CLI agents configured." : lines.join("\n") };
  }

  const lines: string[] = ["CLI Agents:"];
  for (const [agentId, proc] of processes) {
    const uptime = proc.status !== "exited"
      ? `${Math.round((Date.now() - proc.startedAt) / 1000)}s`
      : "-";
    const exit = proc.exitCode !== undefined ? ` (exit: ${proc.exitCode})` : "";
    lines.push(`  ${agentId} [${proc.cli}] — ${proc.status}${exit} | pid: ${proc.pid} | uptime: ${uptime}`);
    lines.push(`    cwd: ${proc.cwd}`);
    lines.push(`    log: ${spawner.getLogPath(proc.team, proc.member)}`);
  }

  // Also show configured but not running
  for (const [teamName, teamConfig] of Object.entries(registry.config.teams)) {
    for (const [memberKey, memberConfig] of Object.entries(teamConfig.members)) {
      if (isCliMember(memberConfig)) {
        const aid = makeAgentId(teamName, memberKey);
        if (!processes.has(aid)) {
          lines.push(`  ${aid} [${memberConfig.cli}] — not started`);
        }
      }
    }
  }

  return { text: lines.join("\n") };
}

async function handleLogs(ctx: {
  args?: string;
}): Promise<{ text?: string }> {
  const registry = getRegistry();
  const spawner = registry.cliSpawner;

  if (!spawner) {
    return { text: "No CLI agents configured." };
  }

  const memberArg = ctx.args?.trim();
  if (!memberArg) {
    return { text: "Usage: /team logs <team>/<member> or /team logs <member>" };
  }

  const resolved = resolveTeamMember(memberArg, registry.config.teams);
  if ("error" in resolved) {
    return { text: resolved.error };
  }

  const logPath = spawner.getLogPath(resolved.team, resolved.member);
  return { text: `Log file: ${logPath}\n\nView with: tail -f ${logPath}` };
}

async function handleStartAgent(ctx: {
  args?: string;
  isAuthorizedSender: boolean;
}): Promise<{ text?: string }> {
  if (!ctx.isAuthorizedSender) {
    return { text: "Permission denied." };
  }

  const registry = getRegistry();
  const spawner = registry.cliSpawner;
  if (!spawner) {
    return { text: "No CLI agents configured." };
  }

  const memberArg = ctx.args?.trim();
  if (!memberArg) {
    return { text: "Usage: /team start <team>/<member> or /team start <member>" };
  }

  const resolved = resolveTeamMember(memberArg, registry.config.teams);
  if ("error" in resolved) {
    return { text: resolved.error };
  }
  const { team, member } = resolved;

  const teamConfig = registry.getTeamConfig(team);
  const memberConfig = teamConfig?.members[member];
  if (!memberConfig || !isCliMember(memberConfig)) {
    return { text: `Member "${member}" is not a CLI agent.` };
  }

  const agentId = makeAgentId(team, member);
  if (spawner.isAlive(agentId)) {
    return { text: `Agent ${agentId} is already running.` };
  }

  const stores = registry.getTeamStores(team);
  if (!stores) {
    return { text: `No stores for team "${team}".` };
  }

  const systemPrompt = await buildSystemPrompt({
    team,
    member,
    teamConfig: teamConfig!,
    memberConfig,
    stores,
    isCli: true,
  });

  await spawner.spawn({
    agentId,
    team,
    member,
    cli: memberConfig.cli!,
    cwd: getCliCwd(memberConfig),
    systemPrompt,
    model: memberConfig.model?.primary,
    thinking: memberConfig.cli_options?.thinking,
    verbose: memberConfig.cli_options?.verbose,
    extraArgs: memberConfig.cli_options?.extra_args,
  });

  return { text: `Agent ${agentId} started.\nLog: ${spawner.getLogPath(team, member)}` };
}

async function handleStopAgent(ctx: {
  args?: string;
  isAuthorizedSender: boolean;
}): Promise<{ text?: string }> {
  if (!ctx.isAuthorizedSender) {
    return { text: "Permission denied." };
  }

  const registry = getRegistry();
  const spawner = registry.cliSpawner;
  if (!spawner) {
    return { text: "No CLI agents configured." };
  }

  const memberArg = ctx.args?.trim();
  if (!memberArg) {
    return { text: "Usage: /team stop-agent <team>/<member> or /team stop-agent <member>" };
  }

  const resolved = resolveTeamMember(memberArg, registry.config.teams);
  if ("error" in resolved) {
    return { text: resolved.error };
  }

  const agentId = makeAgentId(resolved.team, resolved.member);
  if (!spawner.isAlive(agentId)) {
    return { text: `Agent ${agentId} is not running.` };
  }

  spawner.kill(agentId);
  return { text: `Agent ${agentId} stopped.` };
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Parse a "team/member" or "member" argument into { team, member }.
 * Returns an error string if the member is not found.
 */
function resolveTeamMember(
  arg: string,
  teams: Record<string, import("../types.js").TeamConfig>,
): { team: string; member: string } | { error: string } {
  if (arg.includes("/")) {
    const [team, member] = arg.split("/", 2);
    return { team, member };
  }
  const member = arg;
  for (const [teamName, teamConfig] of Object.entries(teams)) {
    if (teamConfig.members[member]) {
      return { team: teamName, member };
    }
  }
  return { error: `Member "${member}" not found in any team.` };
}

function formatTaskCounts(run: TeamRun): string {
  const counts = new Map<TaskState, number>();
  for (const task of run.tasks) {
    counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
  }

  const parts: string[] = [];
  const order: TaskState[] = [
    "COMPLETED", "WORKING", "PENDING", "BLOCKED",
    "INPUT_REQUIRED", "FAILED", "CANCELED",
  ];
  for (const status of order) {
    const count = counts.get(status);
    if (count && count > 0) {
      parts.push(`${status}: ${count}`);
    }
  }

  return `Tasks (${run.tasks.length}): ${parts.join(", ") || "none"}`;
}

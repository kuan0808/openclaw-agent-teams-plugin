/**
 * CLI Spawner — PTY process management for external CLI agents.
 *
 * Spawns CLI agents (Claude Code, Codex, Gemini) as background PTY processes.
 * Each agent gets:
 *  - An MCP config pointing to the mcp-bridge.js script for team tool access
 *  - A system prompt with role, team context, and instructions
 *  - PTY output streamed to a log file for `tail -f` observation
 *  - Crash handler to auto-fail active tasks on process exit
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { CliAgentProcess, CliSpawnParams, PtyHandle } from "./cli-types.js";
import type { CliType, TeamConfig } from "../types.js";
import { makeAgentId } from "../types.js";
import type { PluginRegistry, TeamStores } from "../registry.js";
import { ensureDir } from "../state/persistence.js";

// ── node-pty lazy loading ─────────────────────────────────────────────────
// node-pty is an optional dependency. We load it dynamically to avoid
// hard failures when it's not installed.

interface NodePtyModule {
  spawn(
    file: string,
    args: string[],
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string>;
    },
  ): {
    pid: number;
    onData: (callback: (data: string) => void) => void;
    onExit: (callback: (e: { exitCode: number; signal?: number }) => void) => void;
    write: (data: string) => void;
    kill: (signal?: string) => void;
    resize?: (cols: number, rows: number) => void;
  };
}

let nodePty: NodePtyModule | null = null;

// Module name as variable to prevent static resolution by TypeScript
const NODE_PTY_MODULE = "node-pty";

export async function loadNodePty(): Promise<NodePtyModule> {
  if (nodePty) return nodePty;
  try {
    nodePty = await import(NODE_PTY_MODULE) as unknown as NodePtyModule;
    return nodePty;
  } catch {
    throw new Error(
      "node-pty is required for CLI agent support but not installed. " +
      "Install it with: npm install node-pty",
    );
  }
}

// ── CLI Spawner ───────────────────────────────────────────────────────────

export class CliSpawner {
  private processes: Map<string, CliAgentProcess> = new Map();

  constructor(
    private stateDir: string,
    private sockPath: string,
    private registry?: PluginRegistry,
  ) {}

  /**
   * Spawn a CLI agent process.
   */
  async spawn(params: CliSpawnParams): Promise<CliAgentProcess> {
    const pty = await loadNodePty();

    // Ensure log directory exists
    const logDir = path.join(this.stateDir, "logs", params.team);
    await ensureDir(logDir);
    const logPath = path.join(logDir, `${params.member}.log`);
    const logStream = fs.createWriteStream(logPath, { flags: "a" });

    // Ensure cwd exists
    await ensureDir(params.cwd);

    // Build CLI-specific args and write config files
    const tempFiles: string[] = [];
    const { command, args } = await this.buildCliCommand(params, tempFiles);

    // Spawn PTY process
    const ptyProcess = pty.spawn(command, args, {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: params.cwd,
      env: {
        ...process.env,
        // Ensure agent can find Node for MCP bridge
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
      },
    });

    const agentProcess: CliAgentProcess = {
      agentId: params.agentId,
      team: params.team,
      member: params.member,
      cli: params.cli,
      pty: ptyProcess as unknown as PtyHandle,
      pid: ptyProcess.pid,
      cwd: params.cwd,
      logStream,
      tempFiles,
      startedAt: Date.now(),
      status: "starting",
    };

    // Stream PTY output to log file; mark as running on first data
    ptyProcess.onData((data: string) => {
      logStream.write(data);
      if (agentProcess.status === "starting") {
        agentProcess.status = "running";
      }
    });

    // Crash handler
    ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
      agentProcess.status = "exited";
      agentProcess.exitCode = exitCode;

      // Write exit info to log
      logStream.write(`\n\n[Agent Teams] CLI agent exited with code ${exitCode} at ${new Date().toISOString()}\n`);
      logStream.end();

      if (exitCode !== 0) {
        this.handleCrash(params.agentId, params.team, params.member, params.cli, exitCode);
      }

      // Clean up temp files
      for (const tmpFile of tempFiles) {
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
      }

      // Remove exited process from tracking map
      this.processes.delete(params.agentId);
    });

    this.processes.set(params.agentId, agentProcess);
    return agentProcess;
  }

  /**
   * Kill a specific CLI agent process.
   */
  kill(agentId: string): void {
    const proc = this.processes.get(agentId);
    if (proc && proc.status !== "exited") {
      try {
        proc.pty.kill("SIGTERM");
      } catch {
        // Process may already be dead
      }
    }
    this.processes.delete(agentId);
  }

  /**
   * Kill all CLI agent processes.
   */
  killAll(): void {
    for (const [agentId] of this.processes) {
      this.kill(agentId);
    }
  }

  /**
   * Check if a CLI agent is alive.
   */
  isAlive(agentId: string): boolean {
    const proc = this.processes.get(agentId);
    return !!proc && proc.status !== "exited";
  }

  /**
   * Get a CLI agent process by ID.
   */
  getProcess(agentId: string): CliAgentProcess | undefined {
    return this.processes.get(agentId);
  }

  /**
   * Get all CLI agent processes.
   */
  getAllProcesses(): Map<string, CliAgentProcess> {
    return this.processes;
  }

  /**
   * Get path to a CLI agent's log file.
   */
  getLogPath(team: string, member: string): string {
    return path.join(this.stateDir, "logs", team, `${member}.log`);
  }

  // ── Shared MCP config builder ────────────────────────────────────────

  private buildMcpConfig(agentId: string): object {
    const bridgePath = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "../../dist/cli/mcp-bridge.js",
    );
    return {
      mcpServers: {
        "agent-teams": {
          command: "node",
          args: [bridgePath],
          env: {
            AT_AGENT_ID: agentId,
            AT_SOCK_PATH: this.sockPath,
          },
        },
      },
    };
  }

  private async writeMcpConfig(agentId: string, tempFiles: string[]): Promise<string> {
    const mcpConfigPath = path.join(this.stateDir, "mcp-config", `${agentId}.json`);
    await ensureDir(path.dirname(mcpConfigPath));
    await fsp.writeFile(mcpConfigPath, JSON.stringify(this.buildMcpConfig(agentId), null, 2));
    tempFiles.push(mcpConfigPath);
    return mcpConfigPath;
  }

  // ── Build CLI command ────────────────────────────────────────────────

  private async buildCliCommand(
    params: CliSpawnParams,
    tempFiles: string[],
  ): Promise<{ command: string; args: string[] }> {
    switch (params.cli) {
      case "claude":
        return this.buildClaudeCommand(params, tempFiles);
      case "codex":
        return this.buildCodexCommand(params, tempFiles);
      case "gemini":
        return this.buildGeminiCommand(params, tempFiles);
      default:
        throw new Error(`Unknown CLI type: ${params.cli}`);
    }
  }

  /**
   * Build Claude Code CLI command.
   */
  private async buildClaudeCommand(
    params: CliSpawnParams,
    tempFiles: string[],
  ): Promise<{ command: string; args: string[] }> {
    const mcpConfigPath = await this.writeMcpConfig(params.agentId, tempFiles);

    const args = [
      "--append-system-prompt", params.systemPrompt,
      "--mcp-config", mcpConfigPath,
      "--dangerously-skip-permissions",
    ];

    if (params.model) {
      args.push("--model", params.model);
    }

    if (params.verbose) {
      args.push("--verbose");
    }

    // Print prompt in non-interactive mode
    args.push("-p", params.initialTask
      ? (params.thinking ? `ultrathink ${params.initialTask}` : params.initialTask)
      : (params.thinking ? "ultrathink Check team_inbox and team_task for assignments." : "Check team_inbox and team_task for assignments."),
    );

    if (params.extraArgs) {
      args.push(...params.extraArgs);
    }

    return { command: "claude", args };
  }

  /**
   * Build Codex CLI command.
   */
  private async buildCodexCommand(
    params: CliSpawnParams,
    tempFiles: string[],
  ): Promise<{ command: string; args: string[] }> {
    // Write codex.md in cwd with system prompt
    const codexMdPath = path.join(params.cwd, "codex.md");
    await fsp.writeFile(codexMdPath, params.systemPrompt);
    tempFiles.push(codexMdPath);

    await this.writeMcpConfig(params.agentId, tempFiles);

    const args = [
      "--full-auto",
    ];

    if (params.model) {
      args.push("--model", params.model);
    }

    const taskPrompt = params.initialTask ?? "Check team_inbox and team_task for assignments.";
    args.push("-p", taskPrompt);

    if (params.extraArgs) {
      args.push(...params.extraArgs);
    }

    return { command: "codex", args };
  }

  /**
   * Build Gemini CLI command.
   */
  private async buildGeminiCommand(
    params: CliSpawnParams,
    tempFiles: string[],
  ): Promise<{ command: string; args: string[] }> {
    // Write .gemini/GEMINI.md in cwd with system prompt
    const geminiDir = path.join(params.cwd, ".gemini");
    await ensureDir(geminiDir);

    const geminiMdPath = path.join(geminiDir, "GEMINI.md");
    await fsp.writeFile(geminiMdPath, params.systemPrompt);
    tempFiles.push(geminiMdPath);

    // Write .gemini/settings.json with MCP server config
    const settingsPath = path.join(geminiDir, "settings.json");
    await fsp.writeFile(settingsPath, JSON.stringify(this.buildMcpConfig(params.agentId), null, 2));
    tempFiles.push(settingsPath);

    const args: string[] = [];

    if (params.model) {
      args.push("--model", params.model);
    }

    if (params.thinking) {
      args.push("--thinking");
    }

    const taskPrompt = params.initialTask ?? "Check team_inbox and team_task for assignments.";
    args.push("-p", taskPrompt);

    if (params.extraArgs) {
      args.push(...params.extraArgs);
    }

    return { command: "gemini", args };
  }

  // ── Crash handler ───────────────────────────────────────────────────

  private handleCrash(
    agentId: string,
    team: string,
    member: string,
    cli: CliType,
    exitCode: number,
  ): void {
    if (!this.registry) return;

    const stores = this.registry.getTeamStores(team);
    if (!stores) return;

    const teamConfig = this.registry.getTeamConfig(team);

    // Auto-fail active tasks
    const runResult = stores.runs.getRun(team);
    if (runResult.found) {
      let hasUpdates = false;
      for (const task of runResult.run.tasks) {
        if (task.assigned_to === member && task.status === "WORKING") {
          stores.runs.updateTask(team, task.id, {
            status: "FAILED",
            message: `CLI agent crashed (exit code: ${exitCode})`,
          });

          // Capture learning about the crash
          const learning = {
            content: `CLI agent ${cli} crashed during task: ${task.description}`,
            confidence: 0.7,
            category: "failure" as const,
            task_id: task.id,
            timestamp: Date.now(),
          };
          stores.kv.set(`learnings:failure:${task.id}`, learning, member);

          stores.activity.log(team, member, "task_failed",
            `Task failed: CLI agent ${cli} crashed (exit code: ${exitCode})`, {
              target_id: task.id,
              metadata: { cli, exitCode },
            });

          hasUpdates = true;
        }
      }

      if (hasUpdates) {
        // Save asynchronously — fire-and-forget in crash handler
        Promise.all([
          stores.runs.save(),
          stores.kv.save(),
          stores.activity.save(),
        ]).catch(() => { /* Ignore save errors in crash handler */ });
      }
    }

    // Notify orchestrator
    if (teamConfig?.orchestrator) {
      stores.messages.push(
        member,
        teamConfig.orchestrator,
        `CLI agent "${member}" (${cli}) crashed with exit code ${exitCode}. Active tasks have been marked FAILED.`,
      );
      stores.messages.save().catch(() => { /* Ignore */ });

      // Push notification to orchestrator
      const orchId = makeAgentId(team, teamConfig.orchestrator);
      const orchSession = this.registry.sessions.get(orchId);
      if (orchSession) {
        this.registry.enqueueSystemEvent(
          `[Team Update] CLI agent "${member}" (${cli}) crashed with exit code ${exitCode}. Active tasks marked FAILED.`,
          { sessionKey: orchSession },
        );
        this.registry.requestHeartbeatNow({ agentId: orchId, sessionKey: orchSession });
      }
    }
  }
}

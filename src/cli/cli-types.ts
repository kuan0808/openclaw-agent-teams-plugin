/**
 * CLI agent type definitions.
 *
 * Types for managing external CLI agent processes (Claude Code, Codex, Gemini)
 * spawned via PTY.
 */

import type { WriteStream } from "node:fs";
import type { CliType } from "../types.js";

export interface CliAgentProcess {
  agentId: string;
  team: string;
  member: string;
  cli: CliType;
  pty: PtyHandle;
  pid: number;
  cwd: string;
  logStream: WriteStream;
  tempFiles: string[];       // files to clean up on exit
  startedAt: number;
  status: "starting" | "running" | "exited";
  exitCode?: number;
}

/**
 * Minimal PTY handle interface — abstracts node-pty so we can mock in tests.
 */
export interface PtyHandle {
  pid: number;
  onData: (callback: (data: string) => void) => void;
  onExit: (callback: (e: { exitCode: number; signal?: number }) => void) => void;
  write: (data: string) => void;
  kill: (signal?: string) => void;
  resize?: (cols: number, rows: number) => void;
}

/**
 * Parameters for spawning a CLI agent.
 */
export interface CliSpawnParams {
  agentId: string;
  team: string;
  member: string;
  cli: CliType;
  cwd: string;
  systemPrompt: string;
  initialTask?: string;
  model?: string;
  thinking?: boolean;
  verbose?: boolean;
  extraArgs?: string[];
}

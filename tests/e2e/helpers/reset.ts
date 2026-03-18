/**
 * State reset utilities for E2E tests.
 *
 * The Agent Teams plugin keeps its stores in memory after activation.
 * Deleting files on disk alone does NOT reset plugin runtime state.
 *
 * To get a truly clean E2E environment we:
 * 1. delete plugin state + all agent session transcripts
 * 2. restart the gateway service so the plugin reloads from clean disk
 * 3. fall back to `gateway install` if the service is not currently loaded
 * 4. wait for the gateway probe port to come back
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as net from "node:net";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PLUGIN_DIR =
  process.env.AGENT_TEAMS_STATE_DIR ??
  path.join(os.homedir(), ".openclaw", "plugins", "agent-teams");

const AGENTS_DIR = path.join(os.homedir(), ".openclaw", "agents");
const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");
const OPENCLAW_SCRIPT = path.join(PROJECT_ROOT, "node_modules", "openclaw", "openclaw.mjs");
const NODE = process.execPath;
const GATEWAY_PORT = parseInt(process.env.OPENCLAW_GATEWAY_PORT ?? "18789", 10);
const GATEWAY_HOST = "127.0.0.1";

const STATE_SUBDIRS = ["runs", "kv", "activity", "messages", "docs", "events"];

/**
 * Delete state files for a specific team.
 */
export function cleanTeamState(team: string): void {
  for (const subdir of STATE_SUBDIRS) {
    const dirPath = path.join(PLUGIN_DIR, subdir);
    if (!fs.existsSync(dirPath)) continue;

    const teamPath =
      subdir === "kv"
        ? path.join(dirPath, `${team}.json`)
        : path.join(dirPath, team);

    if (fs.existsSync(teamPath)) {
      fs.rmSync(teamPath, { recursive: true, force: true });
    }
  }
}

/**
 * Delete all state files and broadcast (no gateway restart).
 */
function cleanStateFiles(): void {
  for (const subdir of STATE_SUBDIRS) {
    const dirPath = path.join(PLUGIN_DIR, subdir);
    if (!fs.existsSync(dirPath)) continue;
    const entries = fs.readdirSync(dirPath);
    for (const entry of entries) {
      fs.rmSync(path.join(dirPath, entry), { recursive: true, force: true });
    }
  }

  // Clean broadcast files
  const broadcastPath = path.join(PLUGIN_DIR, "broadcast.jsonl");
  if (fs.existsSync(broadcastPath)) {
    fs.rmSync(broadcastPath, { force: true });
  }
  if (fs.existsSync(PLUGIN_DIR)) {
    for (const entry of fs.readdirSync(PLUGIN_DIR)) {
      if (entry.startsWith("broadcast.jsonl.")) {
        fs.rmSync(path.join(PLUGIN_DIR, entry), { force: true });
      }
    }
  }

  cleanSessions();
}

/**
 * Delete all agent session transcripts/metadata for every agent.
 * This forces the gateway to create fresh sessions on next agent call.
 */
export function cleanSessions(): void {
  if (!fs.existsSync(AGENTS_DIR)) return;

  for (const agentEntry of fs.readdirSync(AGENTS_DIR)) {
    const sessionsDir = path.join(AGENTS_DIR, agentEntry, "sessions");
    if (!fs.existsSync(sessionsDir)) continue;
    for (const entry of fs.readdirSync(sessionsDir)) {
      fs.rmSync(path.join(sessionsDir, entry), { recursive: true, force: true });
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function probeGateway(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(
      { host: GATEWAY_HOST, port: GATEWAY_PORT },
      () => {
        socket.destroy();
        resolve(true);
      },
    );
    socket.on("error", () => resolve(false));
    socket.setTimeout(5_000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitForGatewayState(expectedUp: boolean, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const alive = await probeGateway();
    if (alive === expectedUp) return;
    await sleep(500);
  }

  throw new Error(
    `Gateway did not become ${expectedUp ? "available" : "unavailable"} within ${timeoutMs}ms.`,
  );
}

async function runGatewayCommand(
  args: string[],
  opts?: { allowFailure?: boolean; timeoutMs?: number },
): Promise<void> {
  try {
    await execFileAsync(NODE, [OPENCLAW_SCRIPT, "gateway", ...args], {
      timeout: opts?.timeoutMs ?? 60_000,
      env: process.env,
    });
  } catch (err) {
    if (opts?.allowFailure) return;
    throw err;
  }
}

/**
 * Dependency shape for the gateway-aware reset flow.
 */
export interface GatewayResetDeps {
  cleanStateFiles: () => void;
  runGatewayCommand: (
    args: string[],
    opts?: { allowFailure?: boolean; timeoutMs?: number },
  ) => Promise<void>;
  waitForGatewayState: (expectedUp: boolean, timeoutMs: number) => Promise<void>;
}

/**
 * Fully reset persisted state, then refresh the gateway so the plugin reloads
 * from clean disk instead of stale in-memory stores.
 */
export async function performGatewayAwareReset(deps: GatewayResetDeps): Promise<void> {
  deps.cleanStateFiles();

  try {
    await deps.runGatewayCommand(["restart"], { timeoutMs: 60_000 });
    await deps.waitForGatewayState(true, 60_000);
    return;
  } catch {
    await deps.runGatewayCommand(["install"], { timeoutMs: 60_000 });
    await deps.waitForGatewayState(true, 60_000);
  }
}

/**
 * Fully reset the E2E environment.
 */
export async function cleanAllState(): Promise<void> {
  await performGatewayAwareReset({
    cleanStateFiles,
    runGatewayCommand,
    waitForGatewayState,
  });
}

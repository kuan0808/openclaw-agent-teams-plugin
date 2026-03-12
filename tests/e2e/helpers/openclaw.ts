/**
 * Async CLI wrapper for OpenClaw agent commands.
 *
 * The openclaw CLI uses an ink TUI renderer. Setting CI=true disables it.
 * We also remove VITEST env vars which cause openclaw to suppress output.
 *
 * Each call uses a fresh --session-id to avoid context contamination
 * from previous interactions in the same agent session.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import * as crypto from "node:crypto";

const execAsync = promisify(exec);

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");
const OPENCLAW_SCRIPT = path.join(PROJECT_ROOT, "node_modules", "openclaw", "openclaw.mjs");
const NODE = process.execPath;

/**
 * Env for openclaw CLI: CI=true disables ink TUI; remove VITEST to prevent
 * openclaw from detecting the test environment and suppressing output.
 */
const EXEC_ENV = (() => {
  const env = { ...process.env, CI: "true" };
  delete env.VITEST;
  delete env.VITEST_POOL_ID;
  delete env.VITEST_WORKER_ID;
  return env;
})();

export interface AgentResponse {
  payloads?: Array<{ text?: string; mediaUrl?: string; isError?: boolean }>;
  meta: {
    durationMs: number;
    agentMeta?: { sessionId: string; provider: string; model: string; usage: unknown };
    aborted?: boolean;
    stopReason?: string;
    pendingToolCalls?: Array<{ id: string; name: string; arguments: string }>;
    error?: { kind: string; message: string };
  };
}

/**
 * Send a message to the main OpenClaw agent and return the parsed response.
 *
 * Each call gets a fresh session to avoid context contamination.
 * NOTE: Subagents may still be working after this returns.
 * Use EventWatcher to observe async subagent activity.
 */
export async function askAgent(
  message: string,
  opts?: { timeout?: number; sessionId?: string },
): Promise<AgentResponse> {
  const timeout = opts?.timeout ?? 120_000;
  const sessionId = opts?.sessionId ?? `e2e-${crypto.randomUUID()}`;

  const escaped = message.replace(/'/g, "'\\''");
  const cmd =
    `"${NODE}" "${OPENCLAW_SCRIPT}" agent --agent main ` +
    `--session-id '${sessionId}' ` +
    `--message '${escaped}' --json`;

  const { stdout } = await execAsync(cmd, {
    timeout,
    maxBuffer: 10 * 1024 * 1024,
    env: EXEC_ENV,
  });

  if (!stdout.trim()) {
    throw new Error("Empty response from openclaw CLI.");
  }

  const parsed = JSON.parse(stdout.trim());

  // The CLI wraps the agent response: { runId, status, summary, result: { payloads, meta } }
  if (parsed.result) {
    return parsed.result as AgentResponse;
  }

  return parsed as AgentResponse;
}

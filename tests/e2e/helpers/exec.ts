/**
 * Shared exec helper for openclaw CLI invocation from vitest.
 *
 * The openclaw CLI uses an ink TUI renderer (suppresses output without TTY).
 * Setting CI=true disables the TUI. VITEST env vars must be removed as
 * openclaw detects them and suppresses output entirely.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";

const execPromise = promisify(exec);

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");
const OPENCLAW_SCRIPT = path.join(PROJECT_ROOT, "node_modules", "openclaw", "openclaw.mjs");
const NODE = process.execPath;

/** Clean env: CI=true for plain output, no VITEST vars. */
const EXEC_ENV = (() => {
  const env = { ...process.env, CI: "true" };
  delete env.VITEST;
  delete env.VITEST_POOL_ID;
  delete env.VITEST_WORKER_ID;
  return env;
})();

export interface ExecOpts {
  timeout?: number;
  maxBuffer?: number;
}

/**
 * Execute an openclaw CLI command.
 * Replaces leading "openclaw" with direct node invocation.
 */
export async function execCmd(
  cmd: string,
  opts?: ExecOpts,
): Promise<{ stdout: string; stderr: string }> {
  const resolvedCmd = cmd.startsWith("openclaw ")
    ? `"${NODE}" "${OPENCLAW_SCRIPT}" ${cmd.slice("openclaw ".length)}`
    : cmd;

  return execPromise(resolvedCmd, {
    timeout: opts?.timeout ?? 30_000,
    maxBuffer: opts?.maxBuffer ?? 10 * 1024 * 1024,
    env: EXEC_ENV,
  });
}

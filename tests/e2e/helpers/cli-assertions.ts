/**
 * CLI-agent-specific assertion helpers for E2E tests.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { expect } from "vitest";
import { getPluginDir, readActivity } from "./state.js";

/**
 * Verify CLI agent log files exist and are non-empty.
 * Set `allowEmpty: true` for agents that may run via native session instead of PTY
 * (e.g., orchestrators activated via sessions_send, peers in mixed teams).
 */
export function assertCliAgentLogs(
  team: string,
  cliMembers: string[],
  opts?: { allowEmpty?: boolean },
): void {
  const pluginDir = getPluginDir();
  for (const member of cliMembers) {
    const logPath = path.join(pluginDir, "logs", team, `${member}.log`);
    if (!fs.existsSync(logPath)) {
      if (opts?.allowEmpty) continue;
      expect(false, `Log file missing for CLI agent ${member}`).toBe(true);
      continue;
    }
    const content = fs.readFileSync(logPath, "utf-8");
    if (!opts?.allowEmpty) {
      expect(content.length, `Log file empty for CLI agent ${member}`).toBeGreaterThan(0);
    }
  }
}

/**
 * Verify no CLI agent crash events in activity log.
 */
export function assertNoCrashes(team: string): void {
  const activity = readActivity(team);
  const crashes = activity.filter((e) => e.description.includes("crashed"));
  expect(
    crashes.length,
    `CLI agent crashes detected: ${crashes.map((c) => c.description).join(", ")}`,
  ).toBe(0);
}

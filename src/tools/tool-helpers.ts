/**
 * Shared helpers for all team_* tools.
 *
 * Core context resolution and document helpers live here.
 * Learning, notification, task, and result helpers are in src/helpers/
 * and re-exported below for backward compatibility.
 */

import { resolveTeamContext, type ResolvedTeamContext } from "../context.js";
import { getRegistry } from "../registry.js";
import type { TeamStores } from "../registry.js";
import { parseRunSessionKey, isTeamAgent } from "../types.js";

// ── Re-exports from sub-modules ─────────────────────────────────────────

export { LEARNINGS_KEY_PREFIX, clearLearnings, consolidateLearnings, collectLearnings, isStructuredLearning } from "../helpers/learning-helpers.js";
export { notifyRequester, wakeActiveNativeAssignee, buildMemberActivationMessage } from "../helpers/notification-helpers.js";
export { autoTransitionPendingToWorking, countByStatus } from "../helpers/task-helpers.js";
export { textResult, errorResult, safeSaveAll, buildConsolidatedResult } from "../helpers/result-helpers.js";

// Re-import for local use
import { textResult, errorResult } from "../helpers/result-helpers.js";

// ── Constants ───────────────────────────────────────────────────────────

export const DESCRIPTION_PREVIEW_LEN = 80;
export const RESULT_PREVIEW_LEN = 200;

// ── Tool context ────────────────────────────────────────────────────────

export interface ToolContext {
  config?: unknown;
  agentId?: string;
  sessionKey?: string;
  workspaceDir?: string;
  messageChannel?: string;
  agentAccountId?: string;
}

// ── Agent identity resolution ───────────────────────────────────────────

/**
 * Resolve the effective agent ID from ctx.agentId or ctx.sessionKey.
 *
 * Some gateways don't propagate ctx.agentId to subagent sessions, but the
 * session key always encodes it (format: "agent:<agentId>:run:<runId>").
 * This helper extracts the agent ID from whichever source is available.
 */
export function effectiveAgentId(ctx: ToolContext): string | undefined {
  if (isTeamAgent(ctx.agentId)) return ctx.agentId;
  if (ctx.sessionKey) {
    const parsed = parseRunSessionKey(ctx.sessionKey);
    if (parsed && isTeamAgent(parsed.agentId)) return parsed.agentId;
  }
  return ctx.agentId;  // return original even if not a team agent
}

// ── Tool context resolution ─────────────────────────────────────────────

/**
 * Resolve team context and stores from agent ID and optional team param.
 * Returns an error result if resolution fails.
 */
export function resolveToolContext(
  agentId: string | undefined,
  teamParam: string | undefined,
):
  | { ok: true; teamCtx: ResolvedTeamContext; stores: TeamStores }
  | { ok: false; error: ReturnType<typeof errorResult> } {
  const registry = getRegistry();
  const teamCtx = resolveTeamContext(agentId, teamParam);

  const teamNames = Object.keys(registry.config.teams);

  if (!teamCtx) {
    const teamList = teamNames.length > 0
      ? ` Available teams: ${teamNames.join(", ")}.`
      : "";
    return {
      ok: false,
      error: errorResult(
        `Missing required 'team' parameter.${teamList} Example: team_run(action: "start", team: "${teamNames[0] ?? "my-team"}", goal: "...")`,
      ),
    };
  }

  const stores = registry.getTeamStores(teamCtx.team);
  if (!stores) {
    return {
      ok: false,
      error: errorResult(
        `Team "${teamCtx.team}" not found. Available teams: ${teamNames.join(", ")}`,
      ),
    };
  }

  return { ok: true, teamCtx, stores };
}

// ── Team-only guard ─────────────────────────────────────────────────────

/**
 * Reject calls from non-team agents (main agent).
 * Used by tools that should only be called by team subagents (at-- agents).
 */
export function requireTeamAgent(
  agentId: string | undefined,
  toolName: string,
): ReturnType<typeof errorResult> | null {
  if (isTeamAgent(agentId)) return null;  // OK — team agent

  return errorResult(
    `${toolName} is for team agents only. ` +
    `As the main agent, start a run with team_run(action: "start") and follow the REQUIRED_ACTION to activate team agents. ` +
    `The team agents will use ${toolName} autonomously.`,
  );
}

// ── Stale session guard ─────────────────────────────────────────────────

/**
 * Reject tool calls from agents whose session was explicitly invalidated
 * by run cancellation or completion. Only applies to team agents
 * with run-scoped sessions.
 *
 * Uses the invalidatedSessions set (populated by cleanupRunSessions)
 * rather than checking sessionIndex absence — this avoids false positives
 * when sessions were never registered (e.g., in test environments).
 */
export function checkSessionStillActive(
  agentId: string | undefined,
  sessionKey: string | undefined,
): ReturnType<typeof errorResult> | null {
  if (!sessionKey || !isTeamAgent(agentId)) return null;
  const parsed = parseRunSessionKey(sessionKey);
  if (!parsed) return null;
  const registry = getRegistry();
  if (registry.invalidatedSessions.has(sessionKey)) {
    return errorResult(
      `Your session is no longer active (run was canceled or completed). Stop all work immediately.`,
    );
  }
  return null;
}

// ── Counter restoration ─────────────────────────────────────────────────

/**
 * Restore a monotonic counter from a list of items with prefixed IDs.
 */
export function restoreCounter(
  items: Array<{ id: string }>,
  prefix: string,
): number {
  let counter = 0;
  for (const item of items) {
    const num = parseInt(item.id.replace(prefix, ""), 10);
    if (!isNaN(num) && num >= counter) {
      counter = num + 1;
    }
  }
  return counter;
}

// ── Document key sanitization ────────────────────────────────────────────

export function sanitizeDocumentKey(
  key: string,
): { key: string; changed: boolean } {
  const sanitized = key
    .trim()
    .replace(/[\\/]+/g, "_")
    .replace(/\.\./g, "_");

  return {
    key: sanitized.length > 0 ? sanitized : "document",
    changed: sanitized !== key,
  };
}

// ── Session resolution ──────────────────────────────────────────────────

/**
 * Resolve the runId from a caller's sessionKey.
 */
export function resolveRunIdFromSession(sessionKey?: string): string | undefined {
  if (!sessionKey) return undefined;
  const parsed = parseRunSessionKey(sessionKey);
  return parsed?.runId;
}

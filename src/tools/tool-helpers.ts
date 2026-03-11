/**
 * Shared helpers for all team_* tools.
 */

import type { TaskState, TeamTask, StructuredLearning } from "../types.js";
import type { TeamStores } from "../registry.js";
import { resolveTeamContext, type ResolvedTeamContext } from "../context.js";
import { getRegistry } from "../registry.js";

// ── Constants ───────────────────────────────────────────────────────────

export const LEARNINGS_KEY_PREFIX = "learnings:";

// ── Tool context ────────────────────────────────────────────────────────

export interface ToolContext {
  config?: unknown;
  agentId?: string;
  sessionKey?: string;
  workspaceDir?: string;
  messageChannel?: string;
  agentAccountId?: string;
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

  if (!teamCtx) {
    return {
      ok: false,
      error: errorResult(
        "Cannot resolve team context. Provide a 'team' parameter or use a team agent (at--<team>--<member>).",
      ),
    };
  }

  const stores = registry.getTeamStores(teamCtx.team);
  if (!stores) {
    return {
      ok: false,
      error: errorResult(`Team "${teamCtx.team}" not found in registry.`),
    };
  }

  return { ok: true, teamCtx, stores };
}

// ── Counter restoration ─────────────────────────────────────────────────

/**
 * Restore a monotonic counter from a list of items with prefixed IDs.
 * Returns the next counter value (one past the highest found).
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

// ── Result helpers ──────────────────────────────────────────────────────

export function textResult<T>(data: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

export function errorResult(message: string) {
  return textResult({ error: message });
}

// ── Task status counting (single-pass) ──────────────────────────────────

export function countByStatus(tasks: TeamTask[]): Record<TaskState, number> {
  const counts: Record<string, number> = {
    BLOCKED: 0,
    PENDING: 0,
    WORKING: 0,
    INPUT_REQUIRED: 0,
    COMPLETED: 0,
    FAILED: 0,
    CANCELED: 0,
  };
  for (const t of tasks) {
    counts[t.status] = (counts[t.status] ?? 0) + 1;
  }
  return counts as Record<TaskState, number>;
}

// ── Learnings collection from KV store ──────────────────────────────────

/**
 * Collect learnings from KV store, sorted by confidence descending.
 *
 * Supports both legacy flat keys ("learnings:topic") and structured
 * categorized keys ("learnings:category:topic").
 *
 * Returns up to `limit` entries (default: 10), prioritized by confidence.
 */
export function collectLearnings(
  kv: { iterEntries(): IterableIterator<[string, { key: string; value: unknown }]> },
  limit = 10,
): Array<{ key: string; value: string; confidence?: number; category?: string }> {
  const results: Array<{
    key: string;
    value: string;
    confidence: number;
    category?: string;
  }> = [];

  for (const [, entry] of kv.iterEntries()) {
    if (!entry.key.startsWith(LEARNINGS_KEY_PREFIX)) continue;

    const keyParts = entry.key.slice(LEARNINGS_KEY_PREFIX.length);

    // Check if value is a StructuredLearning object
    if (isStructuredLearning(entry.value)) {
      const sl = entry.value as StructuredLearning;
      results.push({
        key: keyParts,
        value: sl.content,
        confidence: sl.confidence,
        category: sl.category,
      });
    } else {
      // Legacy flat format
      results.push({
        key: keyParts,
        value: typeof entry.value === "string" ? entry.value : JSON.stringify(entry.value),
        confidence: 0.5, // default confidence for unstructured entries
      });
    }
  }

  // Sort by confidence descending, then by key
  results.sort((a, b) => b.confidence - a.confidence || a.key.localeCompare(b.key));

  // Apply limit
  return results.slice(0, limit).map((r) => ({
    key: r.key,
    value: r.value,
    ...(r.confidence !== undefined ? { confidence: r.confidence } : {}),
    ...(r.category ? { category: r.category } : {}),
  }));
}

function isStructuredLearning(value: unknown): value is StructuredLearning {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.content === "string" &&
    typeof v.confidence === "number" &&
    typeof v.category === "string"
  );
}

/**
 * Shared helpers for all team_* tools.
 */

import type { TaskState, TeamTask, StructuredLearning } from "../types.js";
import type { TeamStores } from "../registry.js";
import { resolveTeamContext, type ResolvedTeamContext } from "../context.js";
import { getRegistry, resolveAgentSession } from "../registry.js";
import { makeAgentId, makeRunSessionKey, parseRunSessionKey } from "../types.js";

// ── Constants ───────────────────────────────────────────────────────────

export const LEARNINGS_KEY_PREFIX = "learnings:";
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

// ── Safe sequential saves ────────────────────────────────────────────

/**
 * Execute saves sequentially, collecting errors rather than failing fast.
 * Logs failures to stderr but does not throw.
 */
export async function safeSaveAll(saves: Array<Promise<void>>): Promise<void> {
  for (const save of saves) {
    try {
      await save;
    } catch (err) {
      // Log but don't propagate — partial saves are better than no saves
      console.error("[agent-teams] Save failed:", err);
    }
  }
}

// ── Auto-transition helper ──────────────────────────────────────────

/**
 * Transition all PENDING tasks assigned to a member to WORKING,
 * logging each transition as an activity event.
 * Saves runs + activity if any transitions occurred.
 */
export async function autoTransitionPendingToWorking(
  team: string,
  member: string,
  stores: TeamStores,
  runId?: string,
): Promise<number> {
  const runResult = stores.runs.getRun(team, runId);
  if (!runResult.found) return 0;

  const pendingTasks = runResult.run.tasks.filter(
    (t) => t.assigned_to === member && t.status === "PENDING",
  );
  for (const task of pendingTasks) {
    stores.runs.updateTask(team, task.id, { status: "WORKING" });
    stores.activity.log(team, member, "task_updated",
      `Task status: PENDING → WORKING`, {
        target_id: task.id,
        metadata: { from_status: "PENDING", to_status: "WORKING" },
      });
  }
  if (pendingTasks.length > 0) {
    await safeSaveAll([stores.runs.save(), stores.activity.save()]);
  }
  return pendingTasks.length;
}

export async function wakeActiveNativeAssignee(
  team: string,
  task: Pick<TeamTask, "id" | "description" | "assigned_to" | "status" | "run_id">,
  stores: TeamStores,
): Promise<boolean> {
  if (!task.assigned_to) return false;

  const registry = getRegistry();
  const agentId = makeAgentId(team, task.assigned_to);

  // Look up session key: prefer per-run session, fall back to legacy 1:1
  const sessionKey = resolveAgentSession(registry, agentId, task.run_id);
  if (!sessionKey) return false;

  let changed = false;
  if (task.status === "PENDING") {
    const updated = stores.runs.updateTask(team, task.id, {
      status: "WORKING",
      message: `Assigned to ${task.assigned_to}; session notified.`,
    });
    if (updated) {
      stores.activity.log(team, task.assigned_to, "task_updated",
        "Task status: PENDING → WORKING", {
          target_id: task.id,
          metadata: {
            from_status: "PENDING",
            to_status: "WORKING",
            auto_notified: true,
          },
        });
      changed = true;
    }
  }

  registry.enqueueSystemEvent(
    `[Team Update] New team task assigned to you: ${task.id} — ${task.description.slice(0, 160)}. Check team_task(action: query, filter: "mine") and team_inbox for details.`,
    { sessionKey },
  );
  registry.requestHeartbeatNow({
    agentId,
    reason: "task-assigned",
    sessionKey,
  });

  if (changed) {
    await safeSaveAll([stores.runs.save(), stores.activity.save()]);
  }

  return true;
}

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

// ── Knowledge helpers ───────────────────────────────────────────────

/**
 * Clear all learning entries from KV store (for retention: "current-run").
 */
export function clearLearnings(
  kv: { iterEntries(): IterableIterator<[string, { key: string; value: unknown }]>; delete(key: string): boolean },
): number {
  const keysToDelete: string[] = [];
  for (const [, entry] of kv.iterEntries()) {
    if (entry.key.startsWith(LEARNINGS_KEY_PREFIX)) {
      keysToDelete.push(entry.key);
    }
  }
  for (const key of keysToDelete) {
    kv.delete(key);
  }
  return keysToDelete.length;
}

/**
 * Consolidate learnings from a completed run into a summary entry.
 */
export function consolidateLearnings(
  kv: {
    iterEntries(): IterableIterator<[string, { key: string; value: unknown }]>;
    set(key: string, value: unknown, writtenBy: string): { ok: true; replaced: boolean };
  },
  runId: string,
): { count: number; categories: Record<string, number> } {
  const learnings = collectLearnings(kv, 50); // Collect up to 50 for consolidation
  if (learnings.length === 0) return { count: 0, categories: {} };

  // Group by category
  const byCategory: Record<string, Array<{ key: string; value: string; confidence?: number }>> = {};
  for (const l of learnings) {
    const cat = l.category ?? "uncategorized";
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat]!.push(l);
  }

  // Build consolidated summary
  const categories: Record<string, number> = {};
  const summaryParts: string[] = [];
  for (const [cat, items] of Object.entries(byCategory)) {
    categories[cat] = items.length;
    // Pick top entries by confidence (already sorted)
    const top = items.slice(0, 5);
    summaryParts.push(`## ${cat}\n${top.map((i) => `- ${i.value}`).join("\n")}`);
  }

  const summary = {
    run_id: runId,
    total: learnings.length,
    categories,
    content: summaryParts.join("\n\n"),
    consolidated_at: Date.now(),
  };

  kv.set(`learnings:consolidated:${runId}`, summary, "system");

  return { count: learnings.length, categories };
}

// ── Requester notification ──────────────────────────────────────────────

/**
 * Push a system event notification to the original requester (Main Agent)
 * who started the team run. Uses the stored `requester_session` on the run.
 *
 * When runId is provided, notifies the requester of that specific run.
 * Otherwise falls back to the single active run.
 */
export function notifyRequester(team: string, message: string, runId?: string): void {
  const registry = getRegistry();
  const stores = registry.getTeamStores(team);
  if (!stores) return;
  const run = stores.runs.getRun(team, runId);
  if (!run.found || !run.run.requester_session) return;
  registry.enqueueSystemEvent(
    `[${team} Team] ${message}`,
    { sessionKey: run.run.requester_session },
  );
  registry.requestHeartbeatNow({ sessionKey: run.run.requester_session });
}

/**
 * Resolve the runId from a caller's sessionKey.
 * Returns undefined if the sessionKey doesn't encode a run.
 */
export function resolveRunIdFromSession(sessionKey?: string): string | undefined {
  if (!sessionKey) return undefined;
  const parsed = parseRunSessionKey(sessionKey);
  return parsed?.runId;
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

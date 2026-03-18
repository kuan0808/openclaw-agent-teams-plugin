/**
 * Learning collection, consolidation, and KV helpers.
 */

import type { StructuredLearning } from "../types.js";

export const LEARNINGS_KEY_PREFIX = "learnings:";

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
  const learnings = collectLearnings(kv, 50);
  if (learnings.length === 0) return { count: 0, categories: {} };

  const byCategory: Record<string, Array<{ key: string; value: string; confidence?: number }>> = {};
  for (const l of learnings) {
    const cat = l.category ?? "uncategorized";
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat]!.push(l);
  }

  const categories: Record<string, number> = {};
  const summaryParts: string[] = [];
  for (const [cat, items] of Object.entries(byCategory)) {
    categories[cat] = items.length;
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

/**
 * Collect learnings from KV store, sorted by confidence descending.
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

    if (isStructuredLearning(entry.value)) {
      const sl = entry.value as StructuredLearning;
      results.push({
        key: keyParts,
        value: sl.content,
        confidence: sl.confidence,
        category: sl.category,
      });
    } else {
      results.push({
        key: keyParts,
        value: typeof entry.value === "string" ? entry.value : JSON.stringify(entry.value),
        confidence: 0.5,
      });
    }
  }

  results.sort((a, b) => b.confidence - a.confidence || a.key.localeCompare(b.key));

  return results.slice(0, limit).map((r) => ({
    key: r.key,
    value: r.value,
    ...(r.confidence !== undefined ? { confidence: r.confidence } : {}),
    ...(r.category ? { category: r.category } : {}),
  }));
}

export function isStructuredLearning(value: unknown): value is StructuredLearning {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.content === "string" &&
    typeof v.confidence === "number" &&
    typeof v.category === "string"
  );
}

/**
 * Tool result formatting and safe save helpers.
 */

import type { TeamRun } from "../types.js";

export function textResult<T>(data: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

export function errorResult(message: string) {
  return textResult({ error: message });
}

/**
 * Execute saves sequentially, collecting errors rather than failing fast.
 */
export async function safeSaveAll(saves: Array<Promise<void>>): Promise<void> {
  for (const save of saves) {
    try {
      await save;
    } catch (err) {
      console.error("[agent-teams] Save failed:", err);
    }
  }
}

/**
 * Build a consolidated result summary from all tasks in a run.
 * Used for orchestrator auto-complete when the orchestrator doesn't
 * manually consolidate results.
 */
export function buildConsolidatedResult(run: TeamRun): string {
  const completed = run.tasks.filter((t) => t.status === "COMPLETED");
  const failed = run.tasks.filter((t) => t.status === "FAILED");
  const canceled = run.tasks.filter((t) => t.status === "CANCELED");

  const sections: string[] = [];
  sections.push(`Goal: ${run.goal}`);
  sections.push(`Tasks: ${completed.length} completed, ${failed.length} failed, ${canceled.length} canceled`);

  if (completed.length > 0) {
    sections.push("\nCompleted:");
    for (const t of completed) {
      const result = t.result
        ? (typeof t.result === "string" ? t.result : JSON.stringify(t.result))
        : "(no result)";
      sections.push(`- ${t.description.slice(0, 80)}: ${result.slice(0, 200)}`);
    }
  }

  if (failed.length > 0) {
    sections.push("\nFailed:");
    for (const t of failed) {
      sections.push(`- ${t.description.slice(0, 80)}: ${t.message ?? "unknown error"}`);
    }
  }

  return sections.join("\n");
}

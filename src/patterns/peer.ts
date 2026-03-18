/**
 * Peer coordination pattern.
 *
 * In peer mode there is no designated orchestrator — all members
 * are equal collaborators who self-organize via shared tasks,
 * messages, and memory.
 */

import type { TeamRun } from "../types.js";

/**
 * Check if a peer-mode run should auto-complete.
 *
 * Returns `null` if the run should not auto-complete, or a result object
 * with `allCompleted` indicating whether every task is COMPLETED (vs mixed terminal).
 */
export function shouldAutoComplete(run: TeamRun): { allCompleted: boolean } | null {
  if (run.status !== "WORKING") return null;
  if (run.tasks.length === 0) return null;

  let allCompleted = true;
  for (const t of run.tasks) {
    if (t.status !== "COMPLETED" && t.status !== "FAILED" && t.status !== "CANCELED") {
      return null; // non-terminal task found
    }
    if (t.status !== "COMPLETED") {
      allCompleted = false;
    }
  }

  return { allCompleted };
}

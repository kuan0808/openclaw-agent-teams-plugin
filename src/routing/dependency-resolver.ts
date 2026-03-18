/**
 * Task dependency resolution.
 *
 * Handles:
 *  - Unblocking tasks when dependencies complete
 *  - Checking if a task should be blocked based on pending dependencies
 *  - Cascade-canceling dependents when a task is canceled
 */

import type { TeamTask } from "../types.js";

/**
 * Given that a task has just completed, find and unblock any tasks
 * whose dependencies are now fully satisfied.
 *
 * Mutates the tasks in-place (status BLOCKED -> PENDING) and returns
 * the list of tasks that were unblocked.
 */
export function resolveDependencies(
  tasks: TeamTask[],
  completedTaskId: string,
): TeamTask[] {
  const completedIds = new Set(
    tasks.filter((t) => t.status === "COMPLETED").map((t) => t.id),
  );
  // The just-completed task may not yet be marked COMPLETED in the array
  // if the caller hasn't updated it yet, so add it explicitly.
  completedIds.add(completedTaskId);

  const unblocked: TeamTask[] = [];

  for (const task of tasks) {
    if (task.status !== "BLOCKED") continue;
    if (!task.depends_on || task.depends_on.length === 0) continue;

    const allDepsComplete = task.depends_on.every((dep) => completedIds.has(dep));
    if (allDepsComplete) {
      task.status = "PENDING";
      task.updated_at = Date.now();
      unblocked.push(task);
    }
  }

  return unblocked;
}

/**
 * Check whether a new task with the given dependencies should start
 * in BLOCKED state.
 *
 * Returns true if any dependency is not yet COMPLETED.
 */
export function shouldBlock(
  tasks: TeamTask[],
  dependsOn: string[],
): boolean {
  if (dependsOn.length === 0) return false;

  const completedIds = new Set(
    tasks.filter((t) => t.status === "COMPLETED").map((t) => t.id),
  );

  return dependsOn.some((dep) => !completedIds.has(dep));
}

/**
 * When a task is canceled, cascade-cancel all tasks that depend on it
 * (directly or transitively) and are still in BLOCKED or PENDING state.
 *
 * Mutates tasks in-place and returns the list of cascade-canceled tasks.
 */
export function cascadeCancelDependents(
  tasks: TeamTask[],
  canceledTaskId: string,
): TeamTask[] {
  const canceled: TeamTask[] = [];
  const canceledIds = new Set<string>([canceledTaskId]);

  // Iteratively propagate cancellation until no more dependents are found.
  // This handles transitive dependencies (A -> B -> C).
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of tasks) {
      if (canceledIds.has(task.id)) continue;
      if (task.status !== "BLOCKED" && task.status !== "PENDING" && task.status !== "WORKING") continue;
      if (!task.depends_on || task.depends_on.length === 0) continue;

      const dependsOnCanceled = task.depends_on.some((dep) => canceledIds.has(dep));
      if (dependsOnCanceled) {
        // Find the direct parent that was canceled
        const directParent = task.depends_on.find((dep) => canceledIds.has(dep)) ?? canceledTaskId;
        task.status = "CANCELED";
        task.message = `Cascade-canceled: dependency '${directParent}' was canceled (root: '${canceledTaskId}')`;
        task.updated_at = Date.now();
        canceledIds.add(task.id);
        canceled.push(task);
        changed = true;
      }
    }
  }

  return canceled;
}

/**
 * Detect circular dependencies using DFS.
 *
 * Checks if adding a new task with the given dependencies would create a cycle.
 * Returns the cycle path (array of task IDs) if a cycle is found, null otherwise.
 */
export function detectCycle(
  tasks: TeamTask[],
  newTaskId: string,
  dependsOn: string[],
): string[] | null {
  // Build adjacency map: taskId -> tasks it depends on
  const deps = new Map<string, string[]>();
  for (const task of tasks) {
    if (task.depends_on && task.depends_on.length > 0) {
      deps.set(task.id, task.depends_on);
    }
  }
  // Add the new task's dependencies
  deps.set(newTaskId, dependsOn);

  // DFS cycle detection
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const parent = new Map<string, string>();

  function dfs(nodeId: string): string[] | null {
    visited.add(nodeId);
    inStack.add(nodeId);

    const neighbors = deps.get(nodeId) ?? [];
    for (const dep of neighbors) {
      if (!visited.has(dep)) {
        parent.set(dep, nodeId);
        const cycle = dfs(dep);
        if (cycle) return cycle;
      } else if (inStack.has(dep)) {
        // Found a cycle — reconstruct the path
        const cyclePath: string[] = [dep];
        let current = nodeId;
        while (current !== dep) {
          cyclePath.push(current);
          current = parent.get(current) ?? dep;
        }
        cyclePath.push(dep);
        return cyclePath.reverse();
      }
    }

    inStack.delete(nodeId);
    return null;
  }

  return dfs(newTaskId);
}

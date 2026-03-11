/**
 * Peer coordination pattern.
 *
 * In peer mode there is no designated orchestrator — all members
 * are equal collaborators who self-organize via shared tasks,
 * messages, and memory.
 */

import type { TeamConfig, TeamRun } from "../types.js";

/**
 * Build a peer member's supplementary prepend context.
 */
export function buildPeerContext(
  teamConfig: TeamConfig,
  memberKey: string,
  run: TeamRun | null,
): string {
  const sections: string[] = [];

  const memberConfig = teamConfig.members[memberKey];

  sections.push(
    `## Peer Collaboration Mode`,
    `You are **${memberKey}** in a peer team.`,
    `Your role: ${memberConfig?.role ?? "Team member"}`,
  );

  // Team member directory
  const memberLines = Object.entries(teamConfig.members).map(([key, cfg]) => {
    const skills = cfg.skills?.length ? ` [${cfg.skills.join(", ")}]` : "";
    const marker = key === memberKey ? " (you)" : "";
    return `- **${key}**${marker}: ${cfg.role ?? "member"}${skills}`;
  });
  sections.push(`\nTeam members:\n${memberLines.join("\n")}`);

  // Peer collaboration rules
  sections.push(`
### Peer Rules
1. **Query existing tasks** before creating new ones to avoid duplication.
2. **Create tasks for yourself** when you identify work that matches your skills.
3. **Use team_send** for coordination discussions with specific peers.
4. **Store results in team_memory** so other peers can access them.
5. **Claim unassigned tasks** that match your skills using team_task (action: update).
6. **Publish progress events** via team_events so peers stay informed.
7. **Any member can finalize** the run with team_run (action: complete) when all tasks are done.
8. **Do not duplicate effort** — check task assignments and memory before starting work.`);

  // Run-specific context
  if (run && run.status === "WORKING") {
    const myTasks = run.tasks.filter((t) => t.assigned_to === memberKey);
    const myPending = myTasks.filter((t) => t.status === "PENDING").length;
    const myWorking = myTasks.filter((t) => t.status === "WORKING").length;
    const totalCompleted = run.tasks.filter((t) => t.status === "COMPLETED").length;

    sections.push(
      `\n### Current Run: ${run.id}`,
      `Goal: ${run.goal}`,
      `Your tasks: ${myTasks.length} total (${myWorking} working, ${myPending} pending)`,
      `Team progress: ${totalCompleted}/${run.tasks.length} completed`,
    );
  }

  return sections.join("\n");
}

/**
 * Check if a peer-mode run should auto-complete.
 *
 * Returns true when all tasks are in a terminal state (COMPLETED, FAILED,
 * or CANCELED) and there are no WORKING or PENDING tasks remaining.
 */
export function shouldAutoComplete(run: TeamRun): boolean {
  if (run.status !== "WORKING") return false;
  if (run.tasks.length === 0) return false;

  const activeStatuses = new Set(["PENDING", "WORKING", "BLOCKED", "INPUT_REQUIRED"]);

  return !run.tasks.some((t) => activeStatuses.has(t.status));
}

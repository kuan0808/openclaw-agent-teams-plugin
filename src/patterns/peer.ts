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
1. **Discover tasks** using \`team_task\`(action: query, filter: "available") to find PENDING tasks you can claim.
2. **Query existing tasks** before creating new ones to avoid duplication.
3. **Create tasks for yourself** when you identify work that matches your skills.
4. **Use team_send** for coordination discussions with specific peers.
5. **Store results in team_memory** so other peers can access them.
6. **Claim unassigned tasks** that match your skills using team_task (action: update, assign_to: your_name).
7. **Publish progress events** via team_send (topic: "progress") so peers stay informed.
8. **Any member can finalize** the run with team_run (action: complete) when all tasks are done.
9. **Do not duplicate effort** — use \`team_task\`(action: query, filter: "mine") to check your assignments.`);

  // Run-specific context (single-pass counting)
  if (run && run.status === "WORKING") {
    let myTotal = 0, myWorking = 0, myPending = 0, totalCompleted = 0;
    for (const t of run.tasks) {
      if (t.status === "COMPLETED") totalCompleted++;
      if (t.assigned_to === memberKey) {
        myTotal++;
        if (t.status === "WORKING") myWorking++;
        if (t.status === "PENDING") myPending++;
      }
    }

    sections.push(
      `\n### Current Run: ${run.id}`,
      `Goal: ${run.goal}`,
      `Your tasks: ${myTotal} total (${myWorking} working, ${myPending} pending)`,
      `Team progress: ${totalCompleted}/${run.tasks.length} completed`,
    );
  }

  return sections.join("\n");
}

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

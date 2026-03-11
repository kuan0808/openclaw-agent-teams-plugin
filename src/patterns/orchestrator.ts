/**
 * Orchestrator coordination pattern.
 *
 * Provides context-building for the designated orchestrator member
 * and utilities for identifying the orchestrator.
 */

import type { TeamConfig, TeamRun } from "../types.js";

/**
 * Build the orchestrator's supplementary prepend context.
 *
 * This is appended to the base context from agent-start hook to give
 * the orchestrator its coordination-specific instructions.
 */
export function buildOrchestratorContext(
  teamConfig: TeamConfig,
  run: TeamRun | null,
): string {
  const orchestrator = teamConfig.orchestrator;
  const sections: string[] = [];

  sections.push(
    `## Orchestrator Instructions`,
    `You are the **orchestrator** of team **${run?.team ?? "(unnamed)"}**.`,
    `Your role: ${teamConfig.members[orchestrator!]?.role ?? "Coordinate team work and deliver results."}`,
  );

  // Team member directory with skills
  const memberLines = Object.entries(teamConfig.members).map(([key, cfg]) => {
    const skills = cfg.skills?.length ? ` [${cfg.skills.join(", ")}]` : "";
    const marker = key === orchestrator ? " (you)" : "";
    return `- **${key}**${marker}: ${cfg.role ?? "member"}${skills}`;
  });
  sections.push(`\nTeam members:\n${memberLines.join("\n")}`);

  // Core orchestrator rules
  sections.push(`
### Orchestrator Rules
1. **Delegate, don't do.** Use \`team_task\` to assign work to specialists.
2. **Track progress.** Query task status regularly and unblock dependents.
3. **Consolidate results.** Gather outputs from completed tasks before reporting.
4. **Use team_memory** to share context that multiple members need.
5. **Use team_send** for targeted follow-ups or clarifications.
6. **Complete the run** with \`team_run\` (action: complete) once all tasks are done.`);

  // Run-specific context
  if (run && run.status === "WORKING") {
    const pending = run.tasks.filter((t) => t.status === "PENDING").length;
    const working = run.tasks.filter((t) => t.status === "WORKING").length;
    const completed = run.tasks.filter((t) => t.status === "COMPLETED").length;
    const blocked = run.tasks.filter((t) => t.status === "BLOCKED").length;
    const total = run.tasks.length;

    sections.push(
      `\n### Current Run: ${run.id}`,
      `Goal: ${run.goal}`,
      `Progress: ${completed}/${total} completed, ${working} working, ${pending} pending, ${blocked} blocked`,
    );
  }

  return sections.join("\n");
}

/**
 * Get the orchestrator member key from a team config.
 * Throws if the team uses orchestrator mode but no orchestrator is set.
 */
export function getOrchestratorMember(teamConfig: TeamConfig): string {
  if (teamConfig.coordination !== "orchestrator") {
    throw new Error(
      `Team uses "${teamConfig.coordination}" coordination, not "orchestrator".`,
    );
  }
  if (!teamConfig.orchestrator) {
    throw new Error(
      "Orchestrator mode requires an 'orchestrator' field in team config.",
    );
  }
  if (!(teamConfig.orchestrator in teamConfig.members)) {
    throw new Error(
      `Orchestrator "${teamConfig.orchestrator}" is not listed in team members.`,
    );
  }
  return teamConfig.orchestrator;
}

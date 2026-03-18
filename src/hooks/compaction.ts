/**
 * before_compaction hook — injects team state summary before context compaction.
 *
 * Since before_compaction returns void, we enqueue a system event that will
 * be picked up after compaction, ensuring the compacted context retains
 * awareness of the team's current run, tasks, and key memories.
 */

import { isTeamAgent, parseAgentId, type TeamRun } from "../types.js";
import { getRegistry } from "../registry.js";
import { LEARNINGS_KEY_PREFIX } from "../tools/tool-helpers.js";

export function createCompactionHook(): (
  event: { messageCount: number; compactingCount?: number; tokenCount?: number },
  ctx: { agentId?: string; sessionKey?: string },
) => Promise<void> {
  return async (_event, ctx) => {
    if (!isTeamAgent(ctx.agentId)) {
      if (!ctx.sessionKey) return;
      const registry = getRegistry();
      const teamEntries = Object.entries(registry.config.teams);
      if (teamEntries.length === 0) return;

      const teamList = teamEntries.map(([name, tc]) =>
        `- ${name}: ${tc.description} (${tc.coordination})`
      ).join("\n");

      let summary = [
        "[Agent Teams — Post-Compaction Reminder]",
        "Available teams:",
        teamList,
        "",
        "Quick reference:",
        '- Start: team_run(action: "start", team: "<name>", goal: "...")',
        '- Check: team_run(action: "status", team: "<name>")',
        "- Always execute REQUIRED_ACTION directives in tool responses.",
        "- When you receive [Team Name] notifications, relay progress to the user.",
      ].join("\n");

      // Check for active runs across all teams
      for (const [name] of teamEntries) {
        const teamStores = registry.getTeamStores(name);
        if (!teamStores) continue;
        const workingRuns = teamStores.runs.getWorkingRuns();
        for (const run of workingRuns) {
          const taskCount = run.tasks.length;
          const completed = run.tasks.filter(t => t.status === "COMPLETED").length;
          summary += `\n\nActive run [${name}]: ${run.id} — "${run.goal.slice(0, 80)}" (${completed}/${taskCount} tasks done)`;
        }
      }

      registry.enqueueSystemEvent(summary, { sessionKey: ctx.sessionKey });
      return;
    }
    if (!ctx.sessionKey) return;

    const parsed = parseAgentId(ctx.agentId!);
    if (!parsed) return;

    const { team, member } = parsed;
    const registry = getRegistry();

    const stores = registry.getTeamStores(team);
    if (!stores) return;

    const sections: string[] = [];
    sections.push(`[Agent Teams — Post-Compaction State Restore]`);
    sections.push(`You are **${member}** in team **${team}**.`);

    // Current run goal + status
    const runResult = stores.runs.getRun(team);
    if (runResult.found) {
      const run: TeamRun = runResult.run;
      sections.push(`Current run: ${run.id} (${run.status})`);
      sections.push(`Goal: ${run.goal}`);

      // Task list with statuses
      if (run.tasks.length > 0) {
        sections.push("Tasks:");
        for (const task of run.tasks.slice(0, 20)) {
          const assignee = task.assigned_to ? ` → ${task.assigned_to}` : "";
          sections.push(`  [${task.status}] ${task.id}${assignee}: ${task.description.slice(0, 100)}`);
        }
        if (run.tasks.length > 20) {
          sections.push(`  ... and ${run.tasks.length - 20} more tasks`);
        }
      }
    } else {
      sections.push("No active run.");
    }

    // Key memory entries (up to 10, excluding internal learnings)
    const kvEntries = stores.kv.list()
      .filter(e => !e.key.startsWith(LEARNINGS_KEY_PREFIX))
      .slice(0, 10);
    if (kvEntries.length > 0) {
      sections.push("Key memory entries:");
      for (const entry of kvEntries) {
        const val = stores.kv.get(entry.key);
        if (val.found) {
          const preview = typeof val.value === "string"
            ? val.value.slice(0, 120)
            : JSON.stringify(val.value).slice(0, 120);
          sections.push(`  ${entry.key}: ${preview}`);
        }
      }
    }

    // Add condensed action reminder based on role
    const teamConfig = registry.getTeamConfig(team);
    if (teamConfig) {
      const isOrch = teamConfig.coordination === "orchestrator" && teamConfig.orchestrator === member;
      if (isOrch) {
        sections.push(
          "Reminder: You are the orchestrator. Monitor tasks via team_task(query), " +
          "review completions, and call team_run(complete) when all tasks are done."
        );
      } else {
        sections.push(
          "Reminder: Check team_task(query, filter: mine) for your assignments. " +
          "When done, call team_task(update, status: COMPLETED, result: ...)."
        );
      }
    }

    const summary = sections.join("\n");

    // Enqueue a system event so the post-compaction context includes team state
    registry.enqueueSystemEvent(summary, { sessionKey: ctx.sessionKey });
  };
}

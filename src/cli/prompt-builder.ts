/**
 * Prompt Builder — extract reusable system prompt building logic.
 *
 * Used by both the before_agent_start hook (for native subagents) and
 * the CLI spawner (for external CLI agents).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { TeamConfig, MemberConfig, TeamRun } from "../types.js";
import type { TeamStores } from "../registry.js";
import { collectLearnings, countByStatus } from "../tools/tool-helpers.js";

const OPENCLAW_HOME = path.join(
  process.env.HOME ?? process.env.USERPROFILE ?? ".",
  ".openclaw",
);

export interface BuildSystemPromptParams {
  team: string;
  member: string;
  teamConfig: TeamConfig;
  memberConfig: MemberConfig;
  stores: TeamStores;
  initialTask?: string;
  isCli?: boolean;
  runId?: string;   // Per-run session: scope prompt to this run
}

/**
 * Build a complete system prompt for a team agent.
 * Returns all sections as a single string, suitable for both hook injection
 * and CLI agent system prompt.
 */
export async function buildSystemPrompt(params: BuildSystemPromptParams): Promise<string> {
  const { team, member, teamConfig, memberConfig, stores, initialTask, isCli, runId } = params;
  const sections: string[] = [];

  // 1. Role description
  let roleDescription = memberConfig.role ?? "Team member";
  if (memberConfig.role_file) {
    try {
      const filePath = path.isAbsolute(memberConfig.role_file)
        ? memberConfig.role_file
        : path.resolve(OPENCLAW_HOME, memberConfig.role_file);
      roleDescription = await fs.readFile(filePath, "utf-8");
    } catch {
      // Fall back to inline role if file unreadable
    }
  }
  sections.push(`## Your Role\nYou are **${member}** in team **${team}**.\n${roleDescription}`);

  // 2. Team goal (from current run or specific run)
  let currentRun: TeamRun | null = null;
  const runResult = stores.runs.getRun(team, runId);
  if (runResult.found) {
    currentRun = runResult.run;
    sections.push(`## Current Goal\n${currentRun.goal}`);
  }

  // 3. Team member directory
  const memberLines = Object.entries(teamConfig.members).map(([key, cfg]) => {
    const skills = cfg.skills?.length ? ` | Skills: ${cfg.skills.join(", ")}` : "";
    const cliLabel = cfg.cli ? ` [${cfg.cli}]` : "";
    const marker = key === member ? " (you)" : "";
    return `- **${key}**${marker}: ${cfg.role ?? "member"}${skills}${cliLabel}`;
  });
  sections.push(
    `## Team Members\nCoordination: ${teamConfig.coordination}${teamConfig.orchestrator ? ` | Orchestrator: ${teamConfig.orchestrator}` : ""}\n${memberLines.join("\n")}`,
  );

  // 4. Available tools
  if (isCli) {
    sections.push(
      `## Available Team Tools (via MCP)
You have access to 5 team coordination tools through MCP. Use them to communicate with your team:
- **team_task** — Create, update, or query tasks in the shared board.
- **team_memory** — Read/write shared memory. Use store="kv" (default) for small data, store="docs" for files/reports.
- **team_send** — Send a message to a member (to="name"), broadcast (to="all"), or publish to an event topic (topic="name").
- **team_inbox** — Read your direct messages or subscribe to event queue topics.
- **team_run** — Check run status, complete, or cancel the current run.

IMPORTANT: After completing a task, always:
1. Update the task status with team_task(action: "update", task_id: "...", status: "COMPLETED", result: "...")
2. Check team_inbox for follow-up messages
3. Check team_task(action: "query") for new task assignments`,
    );
  } else {
    sections.push(
      `## Available Team Tools
- **team_task** — Create, update, or query tasks in the shared board.
- **team_memory** — Read/write shared memory. Use store="kv" (default) for small data, store="docs" for files/reports.
- **team_send** — Send a message to a member (to="name"), broadcast (to="all"), or publish to an event topic (topic="name").
- **team_inbox** — Read your direct messages or subscribe to event queue topics.
- **team_run** — Check run status, complete, or cancel the current run.`,
    );

    // Add sessions_send info for orchestrators (native only)
    if (!isCli && teamConfig.coordination === "orchestrator" && teamConfig.orchestrator === member) {
      sections.push(
        `## Platform Tools (Orchestrator Only)
- **sessions_send** — Send a message to a team member's run session. Usage: sessions_send({ message: "Work on: [task]", sessionKey: "agent:at--${team}--{member}:run:{runId}" }). This activates the member for the current run. CLI agents (marked [cli]) are auto-spawned — do not use sessions_send for them.`,
      );
    }
  }

  // 5. Event topics & activity awareness
  const topics = stores.events.getTopics();
  if (topics.length > 0) {
    sections.push(
      `## Event Topics\nActive topics: ${topics.join(", ")}\nUse **team_inbox**(topic: "<name>") to subscribe. Use **team_inbox**(action: "list_topics") to discover all.`,
    );
  }
  sections.push(
    `Use **team_inbox**(source: "activity") to query system events (task/run lifecycle, dependencies).`,
  );

  // 6. Decision flow
  sections.push(buildDecisionFlow(teamConfig, member));

  // 7. Run status summary
  if (currentRun) {
    sections.push(buildRunSummary(currentRun));
  }

  // 8. Previous learnings (sorted by confidence, limited to top 10)
  const learnings = collectLearnings(stores.kv, 10);
  if (learnings.length > 0) {
    const learningLines = learnings.map((l) => {
      const conf = l.confidence !== undefined ? ` (confidence: ${l.confidence})` : "";
      const cat = l.category ? `[${l.category}] ` : "";
      return `- ${cat}**${l.key}**: ${l.value}${conf}`;
    });
    sections.push(`## Previous Learnings\nSorted by confidence. Top ${learnings.length} of available learnings.\n${learningLines.join("\n")}`);
  }

  // 9. Initial task (for CLI agents)
  if (initialTask) {
    sections.push(`## Your Current Task\nYou have been assigned the following task:\n\n${initialTask}\n\nStart working on it immediately. Update task progress using team_task.`);
  }

  return sections.join("\n\n");
}

// ── Helpers ───────────────────────────────────────────────────────────────

export function buildDecisionFlow(teamConfig: TeamConfig, member: string): string {
  if (teamConfig.coordination === "orchestrator") {
    const isOrchestrator = teamConfig.orchestrator === member;
    if (isOrchestrator) {
      return `## Decision Flow (Orchestrator)
1. Receive goal or user request.
2. Break the goal into small, finishable tasks using **team_task** (action: create). Each task should have one clear owner and one concrete deliverable. Avoid broad multi-part tasks that could stall a worker for a long time. Assign each task to the best-fit member.
3. After each task creation, inspect the tool result immediately. If team_task(create) returns requires_session or REQUIRED_ACTION, your next action must be **sessions_send** with the provided sessionKey.
4. **Activate each assigned member** with **sessions_send**({ message: "Work on: [task description]", sessionKey: "agent:at--{team}--{member}:run:{runId}" }). CLI agents [cli] are auto-spawned — skip them. Members cannot work until activated.
5. Report the plan to the user: summarize each task, its assignee, and the execution order.
6. Monitor task progress with **team_task** (action: query).
7. When a member completes a task, review the result and unblock dependents.
8. Consolidate final results and report back with **team_run** (action: complete).
9. Store reusable learnings with **team_memory** for future runs.`;
    }
    return `## Decision Flow (Team Member)
1. Your assigned tasks are automatically set to WORKING when you start.
2. If you need input from another member, use **team_send** or set status to INPUT_REQUIRED.
3. Store intermediate results in **team_memory** for visibility.
4. When done, update the task with status: COMPLETED and attach your result.
5. Do NOT send messages directly to Telegram — deliver results through the orchestrator.`;
  }

  // Peer mode
  return `## Decision Flow (Peer Collaboration)
1. Query existing tasks and inbox before creating anything: **team_task** (action: query) and **team_inbox**.
2. If you already have active tasks, continue them before creating more work for yourself.
3. Create tasks only for uncovered gaps, and prefer small concrete tasks over broad work packages.
4. Coordinate with peers using **team_send** for discussions.
5. Store results in **team_memory** so peers can access them.
6. When all tasks are complete, any member can finalize with **team_run** (action: complete).
7. Do NOT send messages directly to Telegram — results go through the run completion flow.`;
}

export function buildRunSummary(run: TeamRun): string {
  const counts = countByStatus(run.tasks);
  const countStr = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${s}: ${n}`)
    .join(", ");

  const taskLines = run.tasks.slice(0, 15).map((t) => {
    const assignee = t.assigned_to ? ` → ${t.assigned_to}` : "";
    return `  - [${t.status}] ${t.id}${assignee}: ${t.description.slice(0, 80)}`;
  });
  const overflow = run.tasks.length > 15 ? `\n  ... and ${run.tasks.length - 15} more` : "";

  return `## Run Status
- Run ID: ${run.id}
- Status: ${run.status}
- Tasks (${run.tasks.length}): ${countStr}
${taskLines.join("\n")}${overflow}`;
}

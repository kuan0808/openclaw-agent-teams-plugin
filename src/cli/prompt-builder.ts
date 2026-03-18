/**
 * Prompt Builder — reusable system prompt building logic.
 *
 * Used by before_agent_start hook (native subagents), CLI spawner
 * (external CLI agents), and main agent context injection.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentTeamsConfig, TeamConfig, MemberConfig, TeamRun } from "../types.js";
import type { TeamStores } from "../registry.js";
import { collectLearnings, countByStatus } from "../tools/tool-helpers.js";

// ── Main Agent Context ───────────────────────────────────────────────────

/**
 * Build a concise team discovery prompt for the main (non-team) agent.
 * Gives the main agent enough context to know which teams exist and how to use them.
 */
export function buildMainAgentContext(config: AgentTeamsConfig): string {
  const sections: string[] = [];

  sections.push("## Agent Teams Plugin — Available Teams");
  sections.push(
    "You have 5 team coordination tools (team_run, team_task, team_memory, team_send, team_inbox).\n" +
    "Each tool requires a `team` parameter to specify which team to target.",
  );

  // Teams directory as table
  const teamLines: string[] = [];
  for (const [name, tc] of Object.entries(config.teams)) {
    const members = Object.keys(tc.members).join(", ");
    const modeLabel = tc.coordination === "orchestrator"
      ? `orchestrator (${tc.orchestrator})`
      : "peer";
    teamLines.push(`| ${name} | ${tc.description} | ${modeLabel} | ${members} |`);
  }
  sections.push(
    "### Teams\n" +
    "| Team | Description | Mode | Members |\n" +
    "|------|-------------|------|---------|\n" +
    teamLines.join("\n"),
  );

  // Quick start guide
  sections.push(
    '### How to Use\n' +
    '1. Start a run: `team_run(action: "start", team: "<name>", goal: "<goal>")`\n' +
    '2. The response contains `REQUIRED_ACTION` — execute every `sessions_send(...)` call listed.\n' +
    '   - Orchestrator teams: activate the orchestrator agent.\n' +
    '   - Peer teams: activate each peer agent listed in `next_steps`.\n' +
    '   **If sessions_send fails**: Restart the gateway and start a new conversation (/reset).\n' +
    '3. The team works autonomously after activation. You will receive progress notifications\n' +
    '   prefixed with `[<Team> Team]` as system events.\n' +
    '4. **When you receive a notification**: Briefly update the user on team progress. If the\n' +
    '   notification includes `sessions_send` commands, execute them.\n' +
    '5. To check progress manually: `team_run(action: "status", team: "<name>")`\n' +
    '6. Do NOT call team_task directly — team agents handle task decomposition.',
  );

  return sections.join("\n\n");
}

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
- **team_task** — Create, update, or query tasks. Use action: "query" to see your assignments.
- **team_memory** — Shared KV store. Use action: "set" to share results, "get" to read.
- **team_send** — Send messages: to="member_name" (direct) or to="all" (broadcast).
- **team_inbox** — Read your messages (source: "inbox") or system events (source: "activity").
- **team_run** — Check run status or complete/cancel the current run.

## CRITICAL — Before Your Final Response
You MUST call these in order:
1. team_task(action: "update", task_id: "<your task>", status: "COMPLETED",
   result: "<what you built>",
   deliverables: [{ type: "file", path: "<file path>", description: "<what it is>" }])
2. team_inbox(source: "inbox") — check for messages
3. team_task(action: "query", filter: "mine") — check for new assignments

If you skip step 1, your work will be LOST. The system only knows you're done when
you call team_task(update, status: "COMPLETED").`,
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

    // Note: orchestrator activates workers via sessions_send after task creation.
    // The REQUIRED_ACTION in team_task response provides the exact commands.
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
The run is already started. Do NOT call team_run(action: "start").
**Delegate, don't do.** Break down the goal, assign tasks, review results — never implement.

1. **DECOMPOSE**: Call team_task(action: "create", description: "...", assign_to: "member")
   for each piece of work. Keep tasks small and concrete with clear deliverables.
2. **ACTIVATE**: After each team_task(create), check the response for \`REQUIRED_ACTION\`.
   Execute every \`sessions_send(...)\` call to activate assigned members.
3. **MONITOR**: Use team_task(action: "query") to track progress. Check team_inbox for messages.
4. **REVIEW**: When a task completes, evaluate quality.
   - Acceptable → move on.
   - Needs work → team_task(action: "update", task_id: "...",
     status: "REVISION_REQUESTED", message: "Specific feedback on what to fix").
5. **COMPLETE**: When all tasks are done, call team_run(action: "complete",
   result: "Summary of what was built and delivered").
6. **SHARE**: Store reusable knowledge with team_memory for future runs.`;
    }
    return `## Decision Flow (Team Member)
1. Your assigned tasks are automatically set to WORKING. Check team_task(action: "query",
   filter: "mine") to see your assignments.
2. Do your work. Use team_memory(store: "kv", action: "set") to share intermediate results.
3. **CRITICAL** — When done, you MUST call team_task to mark your task complete:
   team_task(action: "update", task_id: "<id>", status: "COMPLETED",
   result: "<what you built and where>",
   deliverables: [{ type: "file", path: "<path>", description: "<what it is>" }])
   If you skip this, the system will not know your work is done and it will be LOST.
4. If your task was sent for REVISION_REQUESTED, read the feedback in team_inbox,
   address it, then resubmit as COMPLETED.
5. After updating, check team_inbox for messages and team_task(query) for new assignments.
6. If the response contains \`REQUIRED_ACTION\` with sessions_send calls, execute them
   to activate members whose tasks were unblocked by your completion.`;
  }

  // Peer mode
  return `## Decision Flow (Peer Collaboration)
**MANDATORY: You MUST use the task system. Do NOT work without creating tasks first.**

1. **CHECK FIRST**: Call team_task(action: "query") and team_inbox before doing anything.
2. If tasks already exist for you, work on them. Do NOT create duplicate tasks.
3. **CREATE TASKS** if none exist for the team goal:
   - Call team_task(action: "create", description: "...", assign_to: "member") for each piece.
   - Assign tasks to the best-suited peer (including yourself). One task per deliverable.
   - This step is NOT optional — skipping it breaks progress tracking for the entire team.
4. **ACTIVATE**: After creating tasks, check each response for \`REQUIRED_ACTION\`.
   Execute every \`sessions_send(...)\` call to activate peers assigned to new tasks.
5. **CRITICAL** — When done, you MUST call team_task to mark your task complete:
   team_task(action: "update", task_id: "<id>", status: "COMPLETED",
   result: "<what you built>",
   deliverables: [{ type: "file", path: "<path>", description: "<desc>" }])
   If you skip this, the system will not know your work is done and it will be LOST.
6. After completing, check for new assignments: team_task(action: "query", filter: "mine").
7. Use team_send to coordinate with peers. Use team_memory to share results.
8. The run auto-completes when all tasks reach terminal state. No manual completion needed.`;
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

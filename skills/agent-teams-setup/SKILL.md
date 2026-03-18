---
name: agent-teams-setup
description: >-
  Set up and configure multi-agent teams for the Agent Teams plugin. Use this
  skill whenever the user mentions agent teams, multi-agent coordination, team
  setup, or needs help with team configuration — even if they don't explicitly
  say "agent teams". Triggers on: "set up a team", "create a team", "agent teams",
  "multi-agent", "team coordination", "orchestrator vs peer", "workflow template",
  "team plugin", "add team members", "configure team", "team config",
  "I want agents to work together", "split work across agents", "coordinate agents",
  "team_run", "team_task", "team_send", "team_inbox", "team_memory",
  "CLI agents", "spawn Claude/Codex/Gemini agents", "peer mode", "orchestrator mode",
  "workflow pipeline", "approval gates", "skill-based routing",
  "troubleshoot team", "team error", "/team status", "/team list".
  Also trigger when the user already has the plugin and asks about tools,
  commands, workflows, or debugging — this skill covers all of that.
---

# Agent Teams Setup

## How to Use This Skill

Determine what the user needs and jump to the right section:

| User Intent | Action |
|-------------|--------|
| "Set up / create a team" | **Section 1: Interactive Setup** |
| "Modify existing team" | Read current config via `openclaw config get plugins.entries.agent-teams.config`, modify, re-apply via Step 4 |
| "Help with tools" | **Section 2** + `references/tool-reference.md` |
| "Workflow / pipeline" | **Section 3** + `references/workflow-templates.md` |
| "How does this work" | **Section 4: Key Concepts** |
| "Error / broken" | **Section 5** + `references/troubleshooting.md` |
| "Show examples" | `references/config-examples.md` |
| "Role files / prompts" | `references/role-file-guide.md` |
| "CLI agents setup" | `references/cli-agents.md` |
| "Orchestrator vs peer" | `references/coordination-patterns.md` |

**Golden rules:**
- Do NOT dump all information at once. Ask clarifying questions.
- Always provide copy-pasteable JSON config blocks.
- After generating config, offer to auto-apply it.
- Reference files in `references/` for deep dives instead of inlining everything.

---

## 1. Interactive Setup

This is the core guided experience. First check prerequisites, then follow the flow.

### Prerequisites

Before setup, verify:
- OpenClaw runtime is installed and working
- The agent-teams plugin is installed (`openclaw plugins list` should show it)

If the plugin isn't installed:
```bash
git clone https://github.com/kuan0808/openclaw-agent-teams-plugin.git
cd openclaw-agent-teams-plugin
npm install && npm run build
openclaw plugins install .
```

**Important — session lifecycle:**
- After applying config, start a **new conversation** (use `/reset` or open a new chat)
  for the new settings to take effect — the gateway auto-restarts on config changes
- Existing sessions cache their permissions at creation time — they cannot pick up
  config changes mid-conversation
- This is a platform behavior, not a plugin limitation

### Step 1: Offer Choices

Present these options to the user:

```
I can help you set up a team! Pick a starting point:

1. 🔍 Co-Reviewer — Multi-perspective code/content review (peer, 3 agents)
2. 👥 Product Team — PM coordinates frontend, backend, and QA (orchestrator)
3. 🔬 Research Team — Research + analysis + report writing (peer, 3 agents)
4. ✍️ Content Creation — Editor-led drafting + fact-checking pipeline (orchestrator)
5. 🔄 Pipeline — Staged workflow with quality gates (orchestrator)
6. ✏️ Custom — Describe what you need and I'll design the config

Which one sounds closest, or tell me what you have in mind?
```

If the user picks 1–5, jump to **Step 2: Apply Template**.
If the user picks 6 or describes something custom, jump to **Step 3: Custom Builder**.
If the user just describes what they want without picking a number, infer the best match or go to Step 3.

### Step 2: Apply Template

Load the matching config from `references/config-examples.md`:

| Choice | Template | Coordination |
|--------|----------|-------------|
| 1 | Co-Reviewer (example 2) | peer |
| 2 | Product Team (example 3) | orchestrator |
| 3 | Research Team (example 5) | peer |
| 4 | Content Creation (example 7) | orchestrator |
| 5 | Pipeline (example 4) | orchestrator |

**Present the config** and ask if the user wants to customize it:

```
Here's the [template name] config:

[show JSON]

Want to adjust anything before I apply it?
- Team name?
- Member names or roles?
- Add/remove members?
- Add CLI agents?

Or should I apply it as-is?
```

Incorporate any requested changes, then proceed to **Step 4: Apply Config**.

### Step 3: Custom Builder

Guide the user through these questions conversationally. You don't need to ask all at once — adapt based on what they've already told you.

**Questions to ask (in order of priority):**

1. **Purpose** — "What will this team do?" (e.g., build features, review code, data pipeline)
2. **Coordination** — "Should one agent lead and assign tasks (orchestrator), or should they be equals who pick up work (peer)?"
   - If unsure: "Orchestrator is good when you want one agent to plan and review. Peer is good when agents have clear skill areas and can self-organize."
3. **Members** — "What roles do you need? For example: frontend dev, backend dev, QA, reviewer, PM..."
4. **Skills** — For each member: "What skills should [member] handle?" (used for automatic task routing)
5. **CLI agents** — "Should any members run as external CLI agents (Claude, Codex, or Gemini)?"
6. **Workflow** — "Do you want staged workflows? (e.g., design → implement → review, where each stage must complete before the next starts)"
7. **Gates** — "Should task completion require deliverables or approval from the leader?"

**After gathering answers, generate the complete config JSON.**

Then proceed to **Step 4: Apply Config**.

### Step 4: Apply Config

After the user approves the config, apply it:

```bash
openclaw config set plugins.entries.agent-teams.config --strict-json '<THE_JSON_CONFIG>'
```

Then tell the user:

```
Config applied! Now start a new conversation to activate:

  /reset

The gateway auto-restarts on config changes, but your current session
still caches the old permissions — so `/reset` (or a new chat) is needed.

Then use the team:
  "Use the [team-name] team to [goal]"

Or check status with: /team status [team-name]
```

**Important:** When generating the `openclaw config set` command:
- The JSON must be valid and on a single line (or properly escaped)
- Use `--strict-json` flag
- The config is the `pluginConfig` content (the object containing `"teams": { ... }`)

---

## 2. Tools Quick Reference

| Tool | Purpose | Key Params |
|------|---------|------------|
| `team_run` | Manage execution runs | `action`: start/status/complete/cancel |
| `team_task` | Create, update, query tasks | `action`: create/update/query; `deliverables`, `learning` |
| `team_memory` | Read/write shared memory | `store`: kv/docs; `action`: get/set/delete/list |
| `team_send` | Send messages & publish events | `to` (direct), `topic` (pub/sub) |
| `team_inbox` | Read messages, events, activity | `source`: inbox/events/activity |

### Typical Workflow

```
1. team_run(action: "start", goal: "Build feature X")
   → Creates a run, returns run_id

2. team_task(action: "create", description: "Implement API endpoint")
   → Routes to best member via skill matching

3. team_task(action: "update", task_id: "...", status: "COMPLETED",
     result: "Done", deliverables: [...])
   → Marks task done, captures learnings, unblocks dependents

4. team_send(to: "pm", message: "API is ready for review")

5. team_run(action: "complete", result: "Feature X shipped")
```

For full parameter docs, see `references/tool-reference.md`.

---

## 3. Workflow Templates

Templates auto-generate a chain of dependent tasks when a run starts. Define `stages` (each becomes a task), `fail_handlers` (loopback on failure), and `gates` (quality checks on transitions). See `references/workflow-templates.md` for full docs and examples, or `references/config-examples.md` example 4 for a complete pipeline config.

---

## 4. Key Concepts

**Coordination modes:** Orchestrator (one leader assigns/reviews) vs. Peer (self-organizing via skill matching, auto-completes when all tasks terminal).

**Agent IDs:** `at--<team>--<member>`. The `team` param is auto-resolved for team agents.

**Task states:** BLOCKED → PENDING → WORKING → COMPLETED / FAILED / CANCELED. Also: INPUT_REQUIRED (needs clarification), REVISION_REQUESTED (reviewer requests changes → back to WORKING).

**Routing:** 1) Direct (`assign_to`), 2) Skill match (`required_skills` vs member `skills[]`), 3) Fallback to orchestrator/peer.

**CLI agents:** Members with `"cli": "claude"|"codex"|"gemini"` spawn on-demand via PTY. Options: `cwd`, `thinking`, `verbose`, `extra_args`.

**Commands:** `/team status`, `/team list`, `/team stop <name>`, `/team agents`, `/team logs <team/member>`, `/team start <team/member>`, `/team stop-agent <team/member>`.

---

## 5. Troubleshooting

Common issues: config errors at activation (misspelled fields, missing `orchestrator` key, empty members), "No active run" (call `team_run(action: "start")` first), gate-blocked transitions (add deliverables/result or use correct approver), tasks stuck in BLOCKED (check dependencies).

See `references/troubleshooting.md` for full error reference, CLI agent diagnostics, and state file inspection.

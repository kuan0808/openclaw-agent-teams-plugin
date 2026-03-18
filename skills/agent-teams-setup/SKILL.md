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
| "Set up / create a team" | **Section 1: Interactive Setup** — walk through guided setup |
| "Help with tools / how do I use X" | **Section 2** + `references/tool-reference.md` |
| "Configure workflow / pipeline" | **Section 3** + `references/workflow-templates.md` |
| "Something is broken / error" | **Section 5** + `references/troubleshooting.md` |
| "Explain how this works" | **Section 4: Key Concepts** |
| "Show me examples" | `references/config-examples.md` |

**Golden rules:**
- Do NOT dump all information at once. Ask clarifying questions.
- Always provide copy-pasteable JSON config blocks.
- After generating config, offer to auto-apply it.
- Reference files in `references/` for deep dives instead of inlining everything.

---

## 1. Interactive Setup

This is the core guided experience. Follow the flow below based on the user's starting point.

### Step 1: Offer Choices

Present these options to the user:

```
I can help you set up a team! Pick a starting point:

1. 🔍 Code Review Pair — Two reviewers with complementary focuses (security + architecture)
2. 👥 Product Team — PM coordinates frontend, backend, and QA
3. 🔄 Pipeline — Staged workflow (design → implement → review) with quality gates
4. 🤖 CLI Agent Team — Mix native agents with Claude/Codex/Gemini CLI agents
5. ✏️ Custom — Describe what you need and I'll design the config

Which one sounds closest, or tell me what you have in mind?
```

If the user picks 1–4, jump to **Step 2: Apply Template**.
If the user picks 5 or describes something custom, jump to **Step 3: Custom Builder**.
If the user just describes what they want without picking a number, infer the best match or go to Step 3.

### Step 2: Apply Template

Load the matching config from `references/config-examples.md`:

| Choice | Template | Coordination |
|--------|----------|-------------|
| 1 | Code Review Pair (example 2) | peer |
| 2 | Product Team (example 3) | orchestrator |
| 3 | Pipeline Team (example 5) | orchestrator |
| 4 | CLI Agent Team (example 4) | orchestrator |

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
Config applied! Restart to activate:

  openclaw gateway restart

After restart, you can use the team:
  "Use the [team-name] team to [goal]"

Or check status with: /team status [team-name]
```

**Important:** When generating the `openclaw config set` command:
- The JSON must be valid and on a single line (or properly escaped)
- Use `--strict-json` flag
- The config is the `pluginConfig` content (the object containing `"teams": { ... }`)

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

Templates auto-generate a chain of dependent tasks when a run starts.

```json
{
  "workflow": {
    "template": {
      "stages": [
        { "name": "design", "role": "designer", "skills": ["design"] },
        { "name": "implement", "role": "developer", "skills": ["coding"] },
        { "name": "review", "role": "reviewer", "skills": ["review"] }
      ],
      "fail_handlers": {
        "review": "implement",
        "implement": "design"
      }
    },
    "gates": {
      "COMPLETED": {
        "require_deliverables": true,
        "require_result": true,
        "approver": "orchestrator"
      }
    }
  }
}
```

**Fail handlers** define loopback: if `review` fails → rework task at `implement`, downstream re-blocks.

**Gates** enforce quality: require deliverables, result summary, or specific approver.

For detailed docs, see `references/workflow-templates.md`.

---

## 4. Key Concepts

### Architecture

```
                    ┌─────────────────────────┐
                    │   openclaw.plugin.json   │
                    │      (team config)       │
                    └──────────┬──────────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
         ┌────▼────┐    ┌─────▼─────┐    ┌─────▼─────┐
         │  Tools  │    │   Hooks   │    │ Commands  │
         │ 5 tools │    │ 4 hooks   │    │ /team ... │
         └────┬────┘    └─────┬─────┘    └─────┬─────┘
              │               │                │
         ┌────▼───────────────▼────────────────▼────┐
         │              State Stores                │
         │  KV · Events · Docs · Runs · Messages    │
         │     Activity Log · Enforcement           │
         ├──────────────────────────────────────────┤
         │  CLI Agents (PTY)  │  Broadcast (.jsonl) │
         └──────────────────────────────────────────┘
```

### Two Coordination Modes

**Orchestrator** — One leader assigns tasks and approves results. Best for structured workflows with clear task ownership.

**Peer** — Members self-organize via a shared task board. Each peer activates with a `CHECK FIRST` directive and an ACTIVATE step to confirm readiness. Tasks route via skill matching with load balancing. The run auto-completes when all tasks reach terminal state.

### Agent IDs

Format: `at--<team>--<member>`. Example: team `product`, member `frontend` → `at--product--frontend`. The `team` parameter is auto-resolved for team agents.

### Task State Machine

```
BLOCKED → PENDING → WORKING → COMPLETED
                  ↘           ↗
              INPUT_REQUIRED
                  ↘
               REVISION_REQUESTED → (back to WORKING)
                  ↘
                FAILED / CANCELED
```

- **BLOCKED** — Waiting for `depends_on` tasks to complete
- **PENDING** — Ready to be picked up
- **WORKING** — Currently being worked on
- **INPUT_REQUIRED** — Needs clarification from requester
- **REVISION_REQUESTED** — Reviewer requested changes; worker picks up to revise
- **COMPLETED** — Done (may trigger auto-learning capture)
- **FAILED** — Failed (triggers fail-loopback if configured; cascade-cancels dependents)
- **CANCELED** — Canceled (by run cancellation or cascade)

### Three-Layer Routing

1. **Direct** — `assign_to: "member-name"` bypasses all routing
2. **Skill match** — `required_skills` matched against member `skills[]` with load balancing
3. **Fallback** — Orchestrator (orchestrator mode) or peer auto-assign

### CLI Agents

Members can run as external CLI agents: `"claude"`, `"codex"`, `"gemini"`. They spawn on-demand when assigned a task.

| Option | Type | Description |
|--------|------|-------------|
| `cwd` | string | Working directory |
| `thinking` | boolean | Enable extended thinking |
| `verbose` | boolean | Verbose CLI output |
| `extra_args` | string[] | Additional CLI flags |

### Commands

| Command | Description |
|---------|-------------|
| `/team status [name]` | Show run progress and task board |
| `/team list` | List all teams |
| `/team stop <name>` | Cancel current run |
| `/team agents` | CLI agent status |
| `/team logs <team/member>` | CLI agent log path |
| `/team start <team/member>` | Manually spawn CLI agent |
| `/team stop-agent <team/member>` | Kill CLI agent |

---

## 5. Troubleshooting

### Common Config Errors

| Error | Fix |
|-------|-----|
| `'coordination' must be "orchestrator" or "peer"` | Check spelling |
| `orchestrator mode requires an 'orchestrator' field` | Add `"orchestrator": "<member-key>"` |
| `orchestrator "X" is not listed in members` | Use a key from `members` |
| `must have at least one member` | Add a member |
| `must have 'role' or 'role_file'` | Add role description |
| `'cli' must be one of claude, codex, gemini` | Check cli value |

### Runtime Issues

- **"No active run"** — Call `team_run(action: "start")` first
- **Gate blocked** — Add required deliverables/result, or use correct approver
- **Task stuck in BLOCKED** — Check dependencies: `team_task(action: "query", filter_status: ["BLOCKED"])`

For more, see `references/troubleshooting.md`.

---

## Config Defaults

| Field | Default |
|-------|---------|
| `workflow.max_rounds` | `10` |
| `workflow.timeout` | `900` (seconds) |
| `knowledge.retention` | `"across-runs"` |
| `knowledge.consolidation` | `true` |
| `knowledge.notify_leader` | `true` |
| `shared_memory.enabled` | `true` |

---
name: agent-teams-setup
description: >-
  Set up and configure multi-agent teams for the Agent Teams plugin. Use when:
  (1) Setting up agent teams for the first time, (2) Creating a new team with
  orchestrator or peer coordination, (3) Adding members, skills, or CLI agents,
  (4) Configuring workflow templates with stages and fail handlers,
  (5) Understanding team tools (team_run, team_task, team_memory, team_send,
  team_inbox), (6) Troubleshooting agent teams config errors, (7) Understanding
  multi-agent coordination patterns, (8) Setting up external CLI agents
  (Claude, Codex, Gemini), (9) Configuring approval gates and deliverables.
  Triggers on: "set up agent teams", "create a team", "agent teams help",
  "team coordination", "multi-agent setup", "orchestrator vs peer",
  "workflow template", "team plugin".
---

## How to Use This Skill

When this skill triggers, first determine what the user needs:

1. **"I want to set up / create a team"** → Start with Section 2 (First-Time Setup),
   then walk through Section 3 (Team Creation Wizard) step by step.
   Ask questions to determine coordination mode, members, skills.
   Generate a complete JSON config block at the end.

2. **"I already have a team, I need help with X"** → Jump to the relevant section:
   - Tools question → Section 4 + `references/tool-reference.md`
   - Workflow/pipeline → Section 6 + `references/workflow-templates.md`
   - Adding members/changing config → Section 3
   - Config examples → `references/config-examples.md`

3. **"Something is broken / error"** → Section 8 + `references/troubleshooting.md`
   Ask for the error message, match against known errors.

4. **"Explain how this works"** → Section 7 (Key Concepts)

5. **"What can teams do?"** → Section 1 (Quick Overview) then offer to dive deeper

Do NOT dump all information at once. Ask clarifying questions.
Always provide copy-pasteable JSON config blocks.
Reference files in `references/` for deep dives instead of inlining everything.

---

## 1. Quick Overview

Agent Teams is an OpenClaw plugin that lets you define multi-agent teams declaratively in JSON.
Teams coordinate through shared tools, messaging, and memory — no custom orchestration code needed.

```
                    ┌─────────────────────────┐
                    │   openclaw.plugin.json   │
                    │   (team config)          │
                    └──────────┬──────────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
         ┌────▼────┐    ┌─────▼─────┐    ┌─────▼─────┐
         │  Tools  │    │   Hooks   │    │ Commands  │
         │ 5 tools │    │ 5 hooks   │    │ /team ... │
         └────┬────┘    └─────┬─────┘    └─────┬─────┘
              │               │                │
         ┌────▼───────────────▼────────────────▼────┐
         │              State Stores                │
         │  KV · Events · Docs · Runs · Messages    │
         │            Activity Log                  │
         └──────────────────────────────────────────┘
```

**Two coordination modes:**

- **Orchestrator** — One leader assigns tasks and approves results. Best for structured workflows with clear task ownership.
- **Peer** — All members are equal. Tasks route via skill matching. Best for collaborative work where any member can pick up tasks.

---

## 2. First-Time Setup

### Prerequisites

- OpenClaw runtime installed and working
- A project with `openclaw.plugin.json` in the root

### Minimal Configuration

Add a `pluginConfig` section for `agent-teams` in your OpenClaw config. The simplest possible team:

```json
{
  "teams": {
    "my-team": {
      "description": "My first team",
      "coordination": "peer",
      "members": {
        "alice": {
          "role": "General-purpose assistant that helps with coding tasks"
        }
      }
    }
  }
}
```

**Required fields:**
- `teams` — Object with at least one team
- `description` — What this team does
- `coordination` — `"orchestrator"` or `"peer"`
- `members` — Object with at least one member, each having `role` or `role_file`

### Verification

After configuring, start OpenClaw. You should see in the logs:
```
Agent Teams plugin activating...
Configured teams: my-team
Team "my-team" stores initialized
Agent Teams plugin activated. 1 team(s), 1 native agent(s), 5 tools, 5 hooks, 3 commands.
```

If you see `Config error:` messages instead, check Section 8 or `references/troubleshooting.md`.

---

## 3. Team Creation Wizard

Walk through these questions with the user to build a config:

### Step 1: Choose Coordination Mode

**Orchestrator** — Choose when:
- You have a clear leader/PM role
- Tasks need approval before completion
- You want structured stage-based workflows
- You need one agent to have final say

**Peer** — Choose when:
- All agents are roughly equal
- You want automatic skill-based routing
- No single agent needs approval authority
- Simple collaborative setups

### Step 2: Define Members

Each member needs:
- **Key** — Unique identifier (used in agent IDs: `at--<team>--<member>`)
- **Role** — Description of what this member does (inline string or `role_file` path)
- **Skills** (optional) — Array of skill tags for routing (e.g., `["frontend", "react", "css"]`)
- **can_delegate** (optional) — Whether this member can create tasks for others (default: false)
- **tools** (optional) — `{ deny: [...], allow: [...] }` to restrict tool access

### Step 3: CLI Agents (Optional)

Members can be external CLI agents instead of OpenClaw subagents:

```json
{
  "backend-dev": {
    "role": "Backend developer specializing in APIs",
    "skills": ["backend", "api", "database"],
    "cli": "claude",
    "cli_options": {
      "cwd": "./backend",
      "thinking": true
    }
  }
}
```

Supported CLI types: `"claude"`, `"codex"`, `"gemini"`

CLI options:
| Option | Type | Description |
|--------|------|-------------|
| `cwd` | string | Working directory for the CLI agent |
| `thinking` | boolean | Enable extended thinking |
| `verbose` | boolean | Enable verbose CLI output |
| `extra_args` | string[] | Additional CLI flags |

CLI agents spawn on-demand when assigned a task — they don't start at plugin activation.

### Step 4: Routing (Orchestrator Mode)

For orchestrator teams, specify which member leads:

```json
{
  "coordination": "orchestrator",
  "orchestrator": "pm",
  "members": {
    "pm": { "role": "Project manager who coordinates the team" },
    "dev": { "role": "Developer", "skills": ["coding"] }
  }
}
```

The `orchestrator` value must match a key in `members`.

Routing config:
```json
{
  "routing": {
    "fallback": "orchestrator"
  }
}
```

The 3-layer routing system:
1. **Direct** — `assign_to` parameter explicitly names a member
2. **Skill match** — `required_skills` matched against member `skills` arrays
3. **Fallback** — Uses `routing.fallback` (default: `"orchestrator"`)

### Step 5: Shared Memory (Optional)

Shared memory is enabled by default. Tune it:

```json
{
  "shared_memory": {
    "enabled": true,
    "stores": {
      "kv": { "max_entries": 1000, "ttl": 3600 },
      "events": { "max_backlog": 500, "retention": "current-task" },
      "docs": { "max_size_mb": 100, "allowed_types": ["text", "json", "csv", "image"] }
    }
  }
}
```

### Example: 3-Member Orchestrator Team

```json
{
  "teams": {
    "product": {
      "description": "Product development team",
      "coordination": "orchestrator",
      "orchestrator": "pm",
      "members": {
        "pm": {
          "role": "Project manager. Breaks down goals into tasks, assigns work, reviews results.",
          "can_delegate": true
        },
        "frontend": {
          "role": "Frontend developer specializing in React and UI/UX",
          "skills": ["frontend", "react", "css", "ui"]
        },
        "backend": {
          "role": "Backend developer specializing in APIs and databases",
          "skills": ["backend", "api", "database", "nodejs"]
        }
      }
    }
  }
}
```

### Example: Peer Team with CLI Agent

```json
{
  "teams": {
    "reviewers": {
      "description": "Code review team",
      "coordination": "peer",
      "members": {
        "reviewer-a": {
          "role": "Code reviewer focusing on architecture and design patterns",
          "skills": ["review", "architecture"]
        },
        "reviewer-b": {
          "role": "Code reviewer focusing on security and performance",
          "skills": ["review", "security", "performance"],
          "cli": "claude",
          "cli_options": { "thinking": true }
        }
      }
    }
  }
}
```

For more examples, see `references/config-examples.md`.

---

## 4. Tool Quick Reference

| Tool | Purpose | Key Params |
|------|---------|------------|
| `team_run` | Manage execution runs | `action`: start/status/complete/cancel |
| `team_task` | Create, update, query tasks | `action`: create/update/query, `deliverables`, `learning` |
| `team_memory` | Read/write shared memory | `store`: kv/docs, `action`: get/set/delete/list |
| `team_send` | Send messages & publish events | `to` (direct), `topic` (pub/sub) |
| `team_inbox` | Read messages, events, activity | `source`: inbox/events/activity |

### Typical Workflow (5 Steps)

```
1. team_run(action: "start", goal: "Build feature X")
   → Creates a run, returns run_id
   → If workflow template exists, auto-generates task chain

2. team_task(action: "create", description: "Implement API endpoint")
   → Routes to best member via skill matching
   → Returns task_id, assigned_to

3. team_task(action: "update", task_id: "...", status: "COMPLETED",
     result: "API endpoint implemented", deliverables: [...])
   → Marks task done, captures learnings, unblocks dependents

4. team_send(to: "pm", message: "API is ready for review")
   → Direct message to a specific member

5. team_run(action: "complete", result: "Feature X shipped")
   → Closes the run, collects all learnings
```

For full parameter docs, see `references/tool-reference.md`.

---

## 5. Commands

All commands are under the `/team` prefix:

| Command | Description | Auth Required |
|---------|-------------|---------------|
| `/team status [name]` | Show run progress, task board, active members | No |
| `/team list` | List all teams with member count and status | No |
| `/team stop <name>` | Cancel the current run for a team | Yes |
| `/team agents` | Show status of all CLI agents | No |
| `/team logs <team/member>` | Print CLI agent log file path | No |
| `/team start <team/member>` | Manually spawn a CLI agent | Yes |
| `/team stop-agent <team/member>` | Kill a running CLI agent | Yes |

Commands accepting `<team/member>` also accept just `<member>` if the member name is unique across teams.

---

## 6. Workflow Templates

Workflow templates auto-generate a chain of dependent tasks when a run starts.
Each stage becomes a task; later stages are BLOCKED until earlier ones complete.

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

**Fail handlers** define loopback: if `review` fails, a rework task is created at the `implement` stage and all downstream tasks are re-blocked.

**Gates** enforce quality checks on status transitions:
- `require_deliverables` — Must attach at least one deliverable
- `require_result` — Must provide a result summary
- `approver` — Only this member (or `"orchestrator"`) can make the transition

For detailed docs, see `references/workflow-templates.md`.

---

## 7. Key Concepts

### Agent IDs

All team agents use the format `at--<team>--<member>`. For example, in team `product` with member `frontend`, the agent ID is `at--product--frontend`. The `team` parameter is auto-resolved for team agents — they don't need to specify it on every tool call.

### Task State Machine

```
BLOCKED → PENDING → WORKING → COMPLETED
                  ↘           ↗
              INPUT_REQUIRED
                  ↘
                FAILED / CANCELED
```

- **BLOCKED** — Waiting for dependencies (`depends_on` tasks to complete)
- **PENDING** — Ready to be picked up
- **WORKING** — Currently being worked on
- **INPUT_REQUIRED** — Needs human input or clarification
- **COMPLETED** — Done (may trigger auto-learning capture)
- **FAILED** — Failed (triggers fail-loopback if workflow template configured)
- **CANCELED** — Canceled (e.g., by run cancellation)

### Three-Layer Routing

1. **Direct assignment** — `assign_to: "member-name"` bypasses all routing
2. **Skill matching** — `required_skills` matched against member `skills[]` with load balancing
3. **Fallback** — `routing.fallback` (default: `"orchestrator"`)

### Learning System

Learnings are auto-captured on task COMPLETED/FAILED:
- **Explicit** — Provide `learning: { content, confidence, category }` on task update
- **Auto-capture** — Generated from task result/failure message when no explicit learning given
- Categories: `failure`, `pattern`, `fix`, `insight`
- Stored in KV with key `learnings:<category>:<task_id>` for cross-run persistence

---

## 8. Troubleshooting

### Common Config Errors

| Error Message | Fix |
|---------------|-----|
| `'coordination' must be "orchestrator" or "peer"` | Check spelling of coordination field |
| `orchestrator mode requires an 'orchestrator' field` | Add `"orchestrator": "<member-key>"` |
| `orchestrator "X" is not listed in members` | Orchestrator key must be a key in members |
| `must have at least one member` | Add at least one member object |
| `must have 'role' or 'role_file'` | Every member needs a role description |
| `'cli' must be one of claude, codex, gemini` | Check cli field value |

### Runtime Issues

- **"No active run"** — Call `team_run(action: "start", goal: "...")` first
- **Gate blocked** — Satisfy the gate condition (add deliverables, result, or use correct approver)
- **Task stuck in BLOCKED** — Its `depends_on` tasks haven't completed yet; query them with `team_task(action: "query")`

### State Files

State files are stored in the directory resolved by `resolveStateDir()` under `plugins/agent-teams/`. The exact path depends on your OpenClaw runtime configuration.

Key state subdirectories:
- `kv/` — Key-value store per team
- `runs/` — Run and task state per team
- `messages/` — Direct messages per team
- `activity/` — Activity log per team
- `broadcast.jsonl` — Real-time event stream

Monitor broadcasts: `tail -f <state-dir>/plugins/agent-teams/broadcast.jsonl | jq`

Query activity programmatically: `team_inbox(source: "activity", filter_type: "task_failed")`

For more, see `references/troubleshooting.md`.

---

## Config Defaults Reference

These defaults are applied when fields are omitted:

| Field | Default |
|-------|---------|
| `workflow.max_rounds` | `10` |
| `workflow.timeout` | `600` (seconds) |
| `knowledge.retention` | `"across-runs"` |
| `knowledge.consolidation` | `true` |
| `knowledge.consolidation_timeout` | `30` (seconds) |
| `knowledge.notify_leader` | `true` |
| `routing.fallback` | `"orchestrator"` |
| `shared_memory.enabled` | `true` |

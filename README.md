<div align="center">

# 🤖 Agent Teams Plugin for OpenClaw

**Define multi-agent teams in JSON. They coordinate through shared tools, messaging, and memory — no custom orchestration code needed.**

[![npm](https://img.shields.io/npm/v/agent-teams?style=flat-square&color=cb3837)](https://www.npmjs.com/package/agent-teams) [![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE) [![OpenClaw >= 2026.3.12](https://img.shields.io/badge/OpenClaw-%3E%3D2026.3.12-7c4dff?style=flat-square)](https://github.com/kuan0808/openclaw) [![Node >= 22](https://img.shields.io/badge/Node-%3E%3D22-43853d?style=flat-square)](https://nodejs.org) [![Tests](https://img.shields.io/badge/tests-351%20passing-brightgreen?style=flat-square)]()

</div>

<br>

## ⚡ Quick Start

```bash
# Install
git clone https://github.com/kuan0808/openclaw-agent-teams-plugin.git
cd openclaw-agent-teams-plugin && npm install && npm run build
openclaw plugins install .

# Configure a team
openclaw config set plugins.entries.agent-teams.config --strict-json '{
  "teams": {
    "dev": {
      "description": "Development team",
      "coordination": "peer",
      "members": {
        "alice": { "role": "Full-stack developer" },
        "bob": { "role": "Backend specialist", "skills": ["api", "database"] }
      }
    }
  }
}'

# Go
openclaw gateway restart
```

Then just ask:

```
You: "Use the dev team to build a REST API for user management"
```

The main agent calls `team_run`, activates peer agents, and they self-organize.

<br>

## 🧙 Guided Setup

This plugin includes a bundled **setup skill** that walks you through team configuration interactively. Just ask:

```
"Help me set up a team"
```

The skill offers **4 preset templates** (Code Review Pair, Product Team, Pipeline, CLI Agent Team) or builds a custom config via Q&A — then applies it automatically with `openclaw config set`. It also handles tool help, workflow setup, and troubleshooting.

<br>

## 🎯 Features

| Feature | Description |
|---------|-------------|
| **Two coordination modes** | Orchestrator (leader assigns & reviews) or Peer (self-organizing via skill matching) |
| **5 built-in tools** | `team_run`, `team_task`, `team_memory`, `team_send`, `team_inbox` |
| **Shared state** | KV store, event queue, document pool, message store, activity log |
| **Workflow templates** | Auto-generated task chains with stages, fail-loopback, and approval gates |
| **CLI agent support** | Spawn external Claude, Codex, or Gemini agents via PTY + IPC + MCP bridge |
| **Concurrent runs** | Multiple independent runs per team with per-run session isolation |
| **Learning system** | Auto-capture on task completion/failure with cross-run persistence |
| **Observability** | `.jsonl` broadcast stream, `/team status`, queryable activity log |

<br>

## 🔄 How It Works

```
Declare team → Start run → Agents coordinate → Run completes
     │              │              │                  │
  JSON config    team_run      team_task          team_run
  with roles     "start"     create/update       "complete"
  & skills                   + messaging
```

| Mode | Behavior |
|------|----------|
| **Orchestrator** | A leader decomposes goals into tasks, assigns by skill, reviews deliverables, and approves completion |
| **Peer** | Members self-organize via a shared task board with skill-based auto-routing and load balancing |

<br>

## 🛠️ Tools Reference

| Tool | Purpose | Key Params |
|------|---------|------------|
| `team_run` | Manage execution runs | `action`: start / status / complete / cancel |
| `team_task` | Create, update, query tasks | `action`: create / update / query; `deliverables`, `learning` |
| `team_memory` | Read/write shared memory | `store`: kv / docs; `action`: get / set / delete / list |
| `team_send` | Send messages & publish events | `to` (direct), `topic` (pub/sub) |
| `team_inbox` | Read messages, events, activity | `source`: inbox / events / activity |

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
   → Direct message to a specific member

5. team_run(action: "complete", result: "Feature X shipped")
   → Closes the run, collects all learnings
```

<br>

## ⚙️ Configuration

<details>
<summary><strong>Peer Team (Minimal)</strong></summary>

```json
{
  "teams": {
    "dev": {
      "description": "Development team",
      "coordination": "peer",
      "members": {
        "alice": { "role": "Full-stack developer" }
      }
    }
  }
}
```

</details>

<details>
<summary><strong>Orchestrator with Skills</strong></summary>

```json
{
  "teams": {
    "product": {
      "description": "Product development team",
      "coordination": "orchestrator",
      "orchestrator": "pm",
      "members": {
        "pm": {
          "role": "Project manager. Breaks down goals, assigns work, reviews results.",
          "can_delegate": true
        },
        "frontend": {
          "role": "Frontend developer specializing in React and UI/UX",
          "skills": ["frontend", "react", "css"]
        },
        "backend": {
          "role": "Backend developer specializing in APIs and databases",
          "skills": ["backend", "api", "database"]
        }
      }
    }
  }
}
```

</details>

<details>
<summary><strong>Full-Featured: Workflow + Gates + CLI Agents</strong></summary>

```json
{
  "teams": {
    "eng": {
      "description": "Engineering team with workflow pipeline",
      "coordination": "orchestrator",
      "orchestrator": "lead",
      "members": {
        "lead": {
          "role": "Tech lead. Decomposes tasks, reviews code, requests revisions.",
          "can_delegate": true
        },
        "dev": {
          "role": "Backend developer",
          "skills": ["backend", "api"],
          "cli": "claude",
          "cli_options": { "cwd": "./backend", "thinking": true }
        },
        "reviewer": {
          "role": "Code reviewer",
          "skills": ["review"]
        }
      },
      "workflow": {
        "timeout": 900,
        "max_rounds": 5,
        "template": {
          "stages": [
            { "name": "implement", "role": "developer", "skills": ["backend"] },
            { "name": "review", "role": "reviewer", "skills": ["review"] }
          ],
          "fail_handlers": { "review": "implement" }
        },
        "gates": {
          "COMPLETED": { "require_deliverables": true, "require_result": true },
          "REVISION_REQUESTED": { "reviewer": "orchestrator" }
        }
      },
      "knowledge": {
        "retention": "across-runs",
        "consolidation": true
      }
    }
  }
}
```

**Workflow templates** auto-generate a chain of dependent tasks when a run starts. **Fail handlers** define loopback — if `review` fails, rework is created at `implement` and downstream tasks re-block.

**Gates** enforce quality checks on status transitions (require deliverables, restrict who can approve).

**Learnings** are auto-captured on task completion/failure with cross-run persistence.

</details>

<br>

<details>
<summary><strong>📋 Config Reference</strong></summary>

### Team Config

| Field | Type | Required | Description |
|-------|------|:--------:|-------------|
| `description` | string | ✅ | What this team does |
| `coordination` | `"orchestrator"` \| `"peer"` | ✅ | Coordination mode |
| `orchestrator` | string | Orch. only | Member key of the team leader |
| `members` | object | ✅ | Member definitions (at least one) |
| `shared_memory` | object | | Memory store configuration |
| `workflow` | object | | Workflow, timeout, and gate settings |
| `knowledge` | object | | Learning system settings |

### Member Config

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `role` | string | — | Role description (required unless `role_file` set) |
| `role_file` | string | — | Path to file containing role description |
| `model` | `{ primary: string }` | — | Model override |
| `skills` | string[] | — | Skill tags for routing |
| `can_delegate` | boolean | `false` | Can create tasks for others |
| `tools` | `{ deny?, allow? }` | — | Tool access restrictions |
| `cli` | `"claude"` \| `"codex"` \| `"gemini"` | — | Spawn as external CLI agent |
| `cli_options` | object | — | CLI-specific settings |

### Defaults

| Field | Default |
|-------|---------|
| `workflow.max_rounds` | `10` |
| `workflow.timeout` | `900` (seconds) |
| `knowledge.retention` | `"across-runs"` |
| `knowledge.consolidation` | `true` |
| `knowledge.notify_leader` | `true` |

</details>

<br>

## 🔒 Mechanism Guarantees

| Mechanism | Trigger | Behavior |
|-----------|---------|----------|
| **Timeout** | `workflow.timeout` elapsed | Auto-cancels run and all non-terminal tasks |
| **Max rounds** | `workflow.max_rounds` loopbacks reached | Auto-cancels the run |
| **Peer auto-complete** | All tasks reach terminal state | Auto-completes the peer run |
| **Cascade cancel** | Task → FAILED or CANCELED | All non-terminal dependent tasks (including WORKING) cascade-canceled |
| **Crash recovery (native)** | Native subagent session ends | Orphaned WORKING tasks marked FAILED |
| **Crash recovery (CLI)** | CLI agent process exits | Exit code 0: auto-completes task. Non-zero: marks FAILED, notifies orchestrator |
| **Orchestrator auto-complete** | All tasks terminal for 60s | Auto-completes the run after grace period |
| **Session cleanup** | Run archived | Per-run session registry entries cleaned up |
| **Audit trail** | Run cancellation | Individual `task_canceled` events per affected task |

> **Lazy enforcement** — no background timers. Every `team_task` / `team_run` call checks limits inline.

<br>

<details>
<summary><strong>🔀 Task State Machine</strong></summary>

```
                         ┌──────────────────┐
                         │     BLOCKED      │ (waiting for depends_on)
                         └────────┬─────────┘
                                  │ dependencies met
                                  ▼
                         ┌──────────────────┐
                    ┌────│     PENDING      │
                    │    └────────┬─────────┘
                    │             │ agent picks up
                    │             ▼
                    │    ┌──────────────────┐     ┌──────────────────────┐
                    │    │     WORKING      │────▶│  REVISION_REQUESTED  │
                    │    └───┬────┬────┬────┘     └──────────┬───────────┘
                    │        │    │    │                      │ worker picks up
                    │        │    │    │                      ▼
                    │        │    │    │              (back to WORKING)
                    │        │    │    │
                    ▼        │    │    ▼
            INPUT_REQUIRED   │    │  FAILED ──▶ cascade cancel dependents
                             │    │
                             ▼    ▼
                         COMPLETED  CANCELED
```

| State | Description |
|-------|-------------|
| `BLOCKED` | Waiting for `depends_on` tasks to complete |
| `PENDING` | Ready to be picked up |
| `WORKING` | Currently being worked on |
| `INPUT_REQUIRED` | Needs clarification from requester |
| `REVISION_REQUESTED` | Reviewer requested changes; worker revises |
| `COMPLETED` | Done (may trigger auto-learning capture) |
| `FAILED` | Failed (triggers fail-loopback; cascade-cancels dependents) |
| `CANCELED` | Canceled (by run cancellation or cascade) |

### Three-Layer Routing

| Priority | Method | How |
|:--------:|--------|-----|
| 1 | **Direct** | `assign_to: "member-name"` bypasses routing |
| 2 | **Skill match** | `required_skills` matched against member `skills[]` with load balancing |
| 3 | **Fallback** | Orchestrator (orch. mode) or peer auto-assign |

</details>

<br>

## 🖥️ CLI Agents

Members can be external CLI agents instead of OpenClaw subagents. They spawn **on-demand** when assigned a task — not at activation.

| CLI | Agent |
|-----|-------|
| `"claude"` | Claude Code CLI |
| `"codex"` | OpenAI Codex CLI |
| `"gemini"` | Google Gemini CLI |

Communication happens via Unix socket IPC + MCP bridge.

<details>
<summary><strong>CLI Options</strong></summary>

| Option | Type | Description |
|--------|------|-------------|
| `cwd` | string | Working directory for the CLI agent |
| `thinking` | boolean | Enable extended thinking / ultrathink |
| `verbose` | boolean | Enable verbose CLI output |
| `extra_args` | string[] | Additional CLI flags |

**Example:**

```json
{
  "backend-dev": {
    "role": "Backend developer specializing in APIs",
    "skills": ["backend", "api", "database"],
    "cli": "claude",
    "cli_options": { "cwd": "./backend", "thinking": true }
  }
}
```

</details>

<br>

## 📟 Commands

All commands use the `/team` prefix:

| Command | Description | Auth |
|---------|-------------|:----:|
| `/team status [name]` | Run progress, task board, active members | |
| `/team list` | All teams with member count and status | |
| `/team stop <name>` | Cancel the current run | 🔐 |
| `/team agents` | Status of all CLI agents | |
| `/team logs <team/member>` | CLI agent log file path | |
| `/team start <team/member>` | Manually spawn a CLI agent | 🔐 |
| `/team stop-agent <team/member>` | Kill a running CLI agent | 🔐 |

> `<team/member>` also accepts just `<member>` if the name is unique across teams.

<br>

## 📊 Observability

The plugin emits a `.jsonl` broadcast stream for every state change — task transitions, messages, learnings, run lifecycle events.

```
{stateDir}/broadcast.jsonl
```

```bash
/team status dev          # Live status
team_inbox(source: "activity")  # Queryable audit trail
```

<br>

<details>
<summary><strong>🏗️ Architecture</strong></summary>

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

- **Entry point** (`index.ts`) — config validation, synchronous registration, store init, session recovery, agent provisioning
- **Agent IDs** — `at--<team>--<member>` format (e.g. `at--product--frontend`)
- **Sessions** — per-run with deterministic keys (`agent:<id>:run:<runId>`) for concurrent isolation
- **Activation** — 3-layer: native subagents registered with host, CLI agents spawned on-demand, all agents receive structured prompts

</details>

<br>

## 🧑‍💻 Development

```bash
npm install              # Install dependencies
npm run build            # Build plugin + MCP bridge
npm test                 # Run all tests — 351 across 31 files
npm run dev              # Watch mode
npm run typecheck        # Type check without emit
```

**Dev mode** — use `--link` to symlink instead of copying:

```bash
npm run build
openclaw plugins install --link .
openclaw gateway restart
```

<br>

## 📄 License

MIT

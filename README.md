# Agent Teams Plugin for OpenClaw

> Define multi-agent teams in JSON. They coordinate through shared tools, messaging, and memory — no custom orchestration code needed.

![OpenClaw >= 2026.3.12](https://img.shields.io/badge/OpenClaw-%3E%3D2026.3.12-blue)
![Node >= 22](https://img.shields.io/badge/Node-%3E%3D22-green)
![Version 1.0.0](https://img.shields.io/badge/version-1.0.0-orange)

## Quick Start (2 Minutes)

```bash
# 1. Install the plugin
git clone https://github.com/kuan0808/openclaw-agent-teams-plugin.git
cd openclaw-agent-teams-plugin
npm install && npm run build
openclaw plugins install .

# 2. Configure a team
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

# 3. Restart and go
openclaw gateway restart
```

Then in any conversation:

```
You: "Use the dev team to build a REST API for user management"
```

The main agent calls `team_run(action: "start")`, activates peer agents, and they self-organize.

## Features

- **Two coordination modes** — Orchestrator (leader assigns, reviews, approves) and Peer (self-organizing via skill matching)
- **5 built-in tools** — `team_run`, `team_task`, `team_memory`, `team_send`, `team_inbox`
- **Shared state** — KV store, event queue, document pool, message store, activity log
- **Mechanism guarantees** — timeout enforcement, max-rounds limits, cascade cancel, peer auto-complete, crash recovery
- **Orchestrator review** — `REVISION_REQUESTED` state with configurable reviewer gates and revision tracking
- **Workflow templates** — auto-generated task chains with stages, fail-loopback, and approval gates
- **Learning system** — auto-capture on task completion/failure with cross-run persistence
- **CLI agent support** — spawn external Claude, Codex, or Gemini agents via PTY + IPC + MCP bridge
- **Concurrent runs** — multiple independent runs per team with per-run session isolation
- **Observability** — `.jsonl` broadcast stream, `/team status`, activity log

## How It Works

```
Declare team → Start run → Agents coordinate → Run completes
     │              │              │                  │
  JSON config    team_run      team_task          team_run
  with roles     "start"     create/update       "complete"
  & skills                   + messaging
```

**Orchestrator mode** — A designated leader decomposes goals into tasks, assigns them to members based on skills, reviews deliverables, can request revisions, and approves completion.

**Peer mode** — Members self-organize via a shared task board. Each peer activates with a `CHECK FIRST` directive and an ACTIVATE step to confirm readiness. Tasks are auto-routed by skill matching with load balancing. The run auto-completes when all tasks reach terminal state.

### Task State Machine

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
| `REVISION_REQUESTED` | Reviewer requested changes; worker picks up to revise |
| `COMPLETED` | Done (may trigger auto-learning capture) |
| `FAILED` | Failed (triggers fail-loopback if configured; cascade-cancels dependents) |
| `CANCELED` | Canceled (by run cancellation or cascade) |

### Three-Layer Routing

1. **Direct** — `assign_to: "member-name"` bypasses all routing
2. **Skill match** — `required_skills` matched against member `skills[]` with load balancing
3. **Fallback** — orchestrator (in orchestrator mode) or peer auto-assign

## Configuration

### Peer Team (Minimal)

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

### Orchestrator with Skills

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

### Full-Featured: Workflow + Gates + CLI Agents

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
          "COMPLETED": {
            "require_deliverables": true,
            "require_result": true
          },
          "REVISION_REQUESTED": {
            "reviewer": "orchestrator"
          }
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

**Workflow templates** auto-generate a chain of dependent tasks when a run starts. **Fail handlers** define loopback — if `review` fails, a rework task is created at `implement` and downstream tasks re-block. Each loopback increments `round_count`, checked against `max_rounds`.

**Gates** enforce quality checks on task status transitions (require deliverables, require result, restrict who can approve or request revisions).

**Learnings** are auto-captured on task completion or failure (explicit or auto-generated), stored in KV with cross-run persistence.

### Config Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `description` | string | Yes | What this team does |
| `coordination` | `"orchestrator"` \| `"peer"` | Yes | Coordination mode |
| `orchestrator` | string | Orchestrator only | Member key of the team leader |
| `members` | object | Yes | Member definitions (at least one) |
| `shared_memory` | object | No | Memory store configuration |
| `routing` | object | No | Task routing settings |
| `workflow` | object | No | Workflow, timeout, and gate settings |
| `knowledge` | object | No | Learning system settings |

### Member Config Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `role` | string | — | Role description (required unless `role_file` set) |
| `role_file` | string | — | Path to file containing role description |
| `model` | `{ primary: string }` | — | Model override |
| `skills` | string[] | — | Skill tags for routing |
| `can_delegate` | boolean | `false` | Whether this member can create tasks for others |
| `tools` | `{ deny?, allow? }` | — | Tool access restrictions |
| `cli` | `"claude"` \| `"codex"` \| `"gemini"` | — | Spawn as external CLI agent |
| `cli_options` | object | — | CLI-specific settings (see [CLI Agents](#cli-agents)) |

### Defaults

| Field | Default |
|-------|---------|
| `workflow.max_rounds` | `10` |
| `workflow.timeout` | `900` (seconds) |
| `knowledge.retention` | `"across-runs"` |
| `knowledge.consolidation` | `true` |
| `knowledge.notify_leader` | `true` |

## Tools Reference

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

## Mechanism Guarantees

The plugin enforces runtime guarantees checked lazily on every tool call:

| Mechanism | Trigger | Behavior |
|-----------|---------|----------|
| **Timeout enforcement** | `workflow.timeout` seconds elapsed | Auto-cancels the run and all non-terminal tasks |
| **Max-rounds enforcement** | `workflow.max_rounds` fail-loopbacks reached | Auto-cancels the run |
| **Peer auto-complete** | All tasks in a peer-mode run reach terminal state | Auto-completes the run |
| **Cascade cancel** | Task transitions to FAILED or CANCELED | All dependent tasks (direct + transitive) are cascade-canceled |
| **Crash recovery (native)** | Native subagent session ends unexpectedly | Orphaned WORKING tasks are marked FAILED |
| **Crash recovery (CLI)** | CLI agent process exits with non-zero code | Active tasks marked FAILED, orchestrator notified |
| **Session cleanup** | Run archived (complete/cancel) | Per-run session registry entries are cleaned up |
| **Audit trail** | Run cancellation | Individual `task_canceled` events logged for each affected task |

**Lazy enforcement** means there are no background timers. Every call to `team_task` or `team_run` checks the current run against its configured limits — since every team interaction passes through these tools, coverage is complete.

## CLI Agents

Members can be external CLI agents instead of OpenClaw subagents:

- `"claude"` — Claude Code CLI
- `"codex"` — OpenAI Codex CLI
- `"gemini"` — Google Gemini CLI

CLI agents spawn **on-demand** when assigned a task — not at plugin activation. Communication happens via Unix socket IPC + MCP bridge.

### CLI Options

| Option | Type | Description |
|--------|------|-------------|
| `cwd` | string | Working directory for the CLI agent |
| `thinking` | boolean | Enable extended thinking / ultrathink |
| `verbose` | boolean | Enable verbose CLI output |
| `extra_args` | string[] | Additional CLI flags |

### Example

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

## Commands Reference

All commands use the `/team` prefix:

| Command | Description | Auth |
|---------|-------------|:----:|
| `/team status [name]` | Show run progress, task board, active members | |
| `/team list` | List all teams with member count and status | |
| `/team stop <name>` | Cancel the current run for a team | Yes |
| `/team agents` | Show status of all CLI agents | |
| `/team logs <team/member>` | Print CLI agent log file path | |
| `/team start <team/member>` | Manually spawn a CLI agent | Yes |
| `/team stop-agent <team/member>` | Kill a running CLI agent | Yes |

Commands accepting `<team/member>` also accept just `<member>` if the name is unique across teams.

## Observability

The plugin emits a `.jsonl` broadcast stream (one event per line) for every state change — task transitions, messages, learning captures, run lifecycle events. Use this for dashboards, debugging, or audit:

```
{stateDir}/broadcast/{team}.jsonl
```

Check live status from the CLI:

```
/team status dev
```

The activity log provides a queryable audit trail via `team_inbox(source: "activity")`.

## Architecture

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

**Entry point** (`index.ts`) orchestrates activation: config validation, runtime compat, synchronous hook/tool/command registration, store initialization, session recovery, agent provisioning, CLI infrastructure, and feature summary logging. Uses per-run session architecture with deterministic session keys (`agent:<id>:run:<runId>`) for concurrent run isolation.

**Activation** uses 3-layer provisioning: native subagents are registered with the host, CLI agents are spawned on-demand via PTY + IPC, and all agents receive structured prompts with role context.

**Agent IDs** follow the format `at--<team>--<member>`. For example, team `product` member `frontend` becomes `at--product--frontend`. The `team` parameter is auto-resolved for team agents.

## Development

### Build & Test

```bash
npm install              # Install dependencies
npm run build            # Build plugin + MCP bridge
npm run build:plugin     # Build plugin only
npm run build:mcp-bridge # Build MCP bridge only
npm run dev              # Watch mode
npm test                 # Run all tests (vitest) — 351 tests across 31 files
npm run test:watch       # Watch mode tests
npm run typecheck        # Type check without emit
```

### Dev Mode (Link)

For development, use `--link` to symlink instead of copying:

```bash
npm run build
openclaw plugins install --link .
openclaw gateway restart
```

With `--link`, changes take effect after `npm run build && openclaw gateway restart`.

## License

MIT

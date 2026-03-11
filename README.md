# openclaw-plugin-agent-teams

Declarative multi-agent team coordination for OpenClaw.

![OpenClaw >= 2026.2.26](https://img.shields.io/badge/OpenClaw-%3E%3D2026.2.26-blue)
![Node >= 22](https://img.shields.io/badge/Node-%3E%3D22-green)
![Version 1.0.0](https://img.shields.io/badge/version-1.0.0-orange)

## Overview

Agent Teams lets you define multi-agent teams in JSON. Teams coordinate through shared tools, messaging, and memory — no custom orchestration code needed.

**Features:**

- Two coordination modes: **Orchestrator** (leader assigns & approves) and **Peer** (skill-based routing)
- 5 built-in tools for runs, tasks, memory, messaging, and inbox
- Shared state: KV store, event queue, document pool, message store, activity log
- File-based event broadcasting (`.jsonl`)
- Workflow templates with stages, fail-loopback, and approval gates
- Learning system with auto-capture and cross-run persistence
- CLI agent support — spawn external Claude, Codex, or Gemini agents via PTY
- `/team` slash commands for status, control, and debugging

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
         │ 5 tools │    │ 5 hooks   │    │ /team ... │
         └────┬────┘    └─────┬─────┘    └─────┬─────┘
              │               │                │
         ┌────▼───────────────▼────────────────▼────┐
         │              State Stores                │
         │  KV · Events · Docs · Runs · Messages    │
         │            Activity Log                  │
         ├──────────────────────────────────────────┤
         │  CLI Agents (PTY)  │  Broadcast (.jsonl) │
         └──────────────────────────────────────────┘
```

Config is validated and parsed at activation. Stores are initialized per team with file-backed persistence (atomic write via tmp + rename). CLI agent infrastructure (IPC server + PTY spawner) starts only when CLI members are configured.

## Prerequisites

- **OpenClaw** >= 2026.2.26
- **Node.js** >= 22
- **node-pty** (optional) — required only if using CLI agents (`cli: "claude"` etc.)

## Installation

### Quick Start

```bash
# Clone into the conventional plugins directory
mkdir -p ~/.openclaw/workspace/plugins
cd ~/.openclaw/workspace/plugins
git clone https://github.com/kuan0808/openclaw-agent-teams-plugin.git agent-teams
cd agent-teams
npm install
npm run build

# Register & enable
openclaw plugins install .
```

This plugin requires team configuration to function. After installing, use the built-in [onboarding skill](#onboarding-skill) to set up your first team interactively:

```
You: "set up agent teams"
```

Or configure manually — see [Configuration](#configuration) for examples.

### Manual Registration

If you prefer manual control or need to keep existing plugins in your config, clone and build as above, then register manually instead of using `openclaw plugins install`:

```bash
# Add to allowed plugins list (keep any existing plugins in the array)
openclaw config set plugins.allow '["agent-teams"]'

# Tell OpenClaw where to find the plugin
openclaw config set plugins.load.paths '["~/.openclaw/workspace/plugins/agent-teams"]'

# Enable the plugin
openclaw config set plugins.entries.agent-teams.enabled true
```

### Dev Mode

```bash
npm run build
openclaw plugins link .
```

Use `npm run dev` for watch mode during development.

## Configuration

### Minimal Peer Team

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

### Orchestrator Team

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

### Team Config Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `description` | string | Yes | What this team does |
| `coordination` | `"orchestrator"` \| `"peer"` | Yes | Coordination mode |
| `orchestrator` | string | Orchestrator only | Member key of the team leader |
| `members` | object | Yes | Member definitions (at least one) |
| `shared_memory` | object | No | Memory store configuration |
| `routing` | object | No | Task routing settings |
| `workflow` | object | No | Workflow and gate settings |
| `knowledge` | object | No | Learning system settings |

### Member Config Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `role` | string | — | Role description (required unless `role_file` set) |
| `role_file` | string | — | Path to file containing role description |
| `model` | `{ primary: string }` | — | Model override |
| `skills` | string[] | — | Skill tags for routing (e.g., `["frontend", "react"]`) |
| `can_delegate` | boolean | `false` | Whether this member can create tasks for others |
| `tools` | `{ deny?, allow? }` | — | Tool access restrictions |
| `cli` | `"claude"` \| `"codex"` \| `"gemini"` | — | Spawn as external CLI agent |
| `cli_options` | object | — | CLI-specific settings (see [CLI Agents](#cli-agents)) |

### Defaults

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

## Tools

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

## Commands

All commands use the `/team` prefix:

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

## Key Concepts

### Coordination Modes

- **Orchestrator** — One leader member assigns tasks, reviews results, and has approval authority. Best for structured workflows with clear task ownership. Requires the `orchestrator` field to name the leader.
- **Peer** — All members are equal. Tasks route automatically via skill matching. Best for collaborative work where any member can pick up tasks.

### Agent IDs

All team agents use the format `at--<team>--<member>`. For example, team `product` member `frontend` → agent ID `at--product--frontend`. The `team` parameter is auto-resolved for team agents.

### Task State Machine

```
BLOCKED → PENDING → WORKING → COMPLETED
                  ↘           ↗
              INPUT_REQUIRED
                  ↘
                FAILED / CANCELED
```

- **BLOCKED** — Waiting for `depends_on` tasks to complete
- **PENDING** — Ready to be picked up
- **WORKING** — Currently being worked on
- **INPUT_REQUIRED** — Needs clarification or human input
- **COMPLETED** — Done (may trigger auto-learning capture)
- **FAILED** — Failed (triggers fail-loopback if workflow template configured)
- **CANCELED** — Canceled (e.g., by run cancellation)

### Three-Layer Routing

1. **Direct** — `assign_to: "member-name"` bypasses all routing
2. **Skill match** — `required_skills` matched against member `skills[]` with load balancing
3. **Fallback** — Uses `routing.fallback` (default: `"orchestrator"`)

### Learning System

Learnings are auto-captured on task completion or failure:

- **Explicit** — Provide `learning: { content, confidence, category }` on task update
- **Auto-capture** — Generated from task result/failure message when no explicit learning given
- Categories: `failure`, `pattern`, `fix`, `insight`
- Stored in KV with key `learnings:<category>:<task_id>` for cross-run persistence

## CLI Agents

Members can be external CLI agents instead of OpenClaw subagents. Supported CLIs:

- `"claude"` — Claude Code CLI
- `"codex"` — OpenAI Codex CLI
- `"gemini"` — Google Gemini CLI

CLI agents spawn **on-demand** when assigned a task — they don't start at plugin activation. Communication happens via Unix socket IPC + MCP bridge.

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

## Workflow Templates

Workflow templates auto-generate a chain of dependent tasks when a run starts. Each stage becomes a task; later stages are BLOCKED until earlier ones complete.

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

## Onboarding Skill

The plugin includes an `agent-teams-setup` skill that provides interactive onboarding:

- Step-by-step team creation wizard
- Coordination mode selection guidance
- Config generation with copy-pasteable JSON
- Tool and command reference
- Troubleshooting help

Trigger phrases: "set up agent teams", "create a team", "agent teams help", "team coordination", "multi-agent setup".

## Development

### Build & Test

```bash
npm install              # Install dependencies
npm run build            # Build plugin + MCP bridge
npm run build:plugin     # Build plugin only
npm run build:mcp-bridge # Build MCP bridge only
npm run dev              # Watch mode
npm test                 # Run all tests (vitest)
npm run test:watch       # Watch mode tests
npm run typecheck        # Type check without emit
```

### Project Structure

```
├── index.ts                  # Plugin entry point
├── openclaw.plugin.json      # OpenClaw plugin manifest
├── package.json
├── tsconfig.json
├── tsconfig.mcp-bridge.json  # Separate build for MCP bridge
├── src/
│   ├── config.ts             # Config validation & parsing
│   ├── registry.ts           # Global plugin registry
│   ├── types.ts              # Type definitions
│   ├── context.ts            # Tool context helpers
│   ├── broadcast.ts          # File-based event broadcasting
│   ├── cli/                  # CLI agent infrastructure
│   │   ├── cli-spawner.ts    # PTY process management
│   │   ├── cli-types.ts      # CLI type definitions
│   │   ├── ipc-server.ts     # Unix socket JSON-RPC server
│   │   ├── mcp-bridge.ts     # MCP server for CLI agents
│   │   └── prompt-builder.ts # Shared prompt builder
│   ├── commands/             # /team slash commands
│   ├── hooks/                # Lifecycle hooks
│   ├── routing/              # 3-layer task routing
│   ├── setup/                # Agent provisioning
│   ├── state/                # State stores (KV, events, docs, runs, messages, activity)
│   ├── tools/                # 5 team tools
│   ├── workflow/             # Workflow template engine
│   └── patterns/             # Coordination pattern logic
├── skills/
│   └── agent-teams-setup/    # Onboarding skill
├── tests/                    # Vitest test suite (151 tests)
└── docs/                     # Additional documentation
```

### Test Suite

151 tests across 14 test files covering config validation, state stores, tools, routing, hooks, CLI spawner, IPC server, workflow engine, and broadcasting.

## License

TBD

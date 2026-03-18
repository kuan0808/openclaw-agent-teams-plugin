# CLI Agents

Comprehensive guide for running external CLI agents (Claude Code, Codex, Gemini) as team members.

---

## Overview

Team members can run as external CLI processes instead of native OpenClaw subagents. Each CLI agent is spawned as a PTY process with its own working directory, log file, and access to team tools via an MCP bridge over IPC.

This lets you mix AI providers in a single team -- for example, a native OpenClaw orchestrator coordinating Claude Code and Codex workers.

---

## Prerequisites

1. **Install the CLI tool** for the provider you want to use:
   - Claude Code: `claude` ([https://docs.anthropic.com/en/docs/claude-code](https://docs.anthropic.com/en/docs/claude-code))
   - OpenAI Codex: `codex` ([https://github.com/openai/codex](https://github.com/openai/codex))
   - Google Gemini CLI: `gemini` ([https://github.com/google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli))

2. **Verify installation:**
   ```bash
   which claude    # or: which codex / which gemini
   ```

3. **Install node-pty** (required for PTY process management):
   ```bash
   npm install node-pty
   ```
   `node-pty` is an optional dependency. The plugin works without it, but CLI agents will not be available. If node-pty is missing and you try to use a CLI agent, you will get the error: `"node-pty is required for CLI agent support but not installed"`.

---

## Configuration

Add `cli` and optionally `cli_options` to a member config:

```json
{
  "teams": {
    "dev-team": {
      "description": "Development team with CLI workers",
      "coordination": "orchestrator",
      "orchestrator": "lead",
      "members": {
        "lead": {
          "role": "Team lead. Coordinates work and reviews results."
        },
        "claude-worker": {
          "role": "Implementation developer",
          "skills": ["coding", "testing"],
          "cli": "claude",
          "cli_options": {
            "cwd": "./src",
            "thinking": true,
            "verbose": true,
            "extra_args": ["--max-turns", "30"]
          }
        },
        "codex-worker": {
          "role": "Rapid prototyping developer",
          "skills": ["prototyping", "scripts"],
          "cli": "codex",
          "cli_options": {
            "cwd": "./experiments"
          }
        },
        "gemini-worker": {
          "role": "Research and analysis agent",
          "skills": ["research", "analysis"],
          "cli": "gemini",
          "cli_options": {
            "thinking": true
          }
        }
      }
    }
  }
}
```

---

## CLI Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `cwd` | string | `process.cwd()` | Working directory for the CLI agent. Relative paths resolve from the current working directory. |
| `thinking` | boolean | `false` | Enable extended thinking. Implementation varies by CLI (see Per-CLI Differences). |
| `verbose` | boolean | `false` | Enable verbose output. Only supported by Claude. |
| `extra_args` | string[] | `[]` | Additional CLI flags passed directly to the command. Escape hatch for advanced use. |

The member-level `model.primary` field also applies to CLI agents — it's passed as `--model <id>` to all three CLI types.

---

## Per-CLI Differences

Each CLI tool has different mechanisms for system prompts, thinking modes, and configuration:

| Aspect | Claude | Codex | Gemini |
|--------|--------|-------|--------|
| System prompt | `--append-system-prompt` flag | `codex.md` file via `--instructions` | `GEMINI.md` file in `.gemini/` dir |
| Thinking mode | Prompt prefix `"ultrathink ..."` (not a CLI flag) | Not supported | Native `--thinking` flag |
| Verbose mode | `--verbose` flag | Not supported | Not supported |
| MCP config | `--mcp-config <path>` flag | Settings file | `.gemini/settings.json` file |
| Permission mode | `--dangerously-skip-permissions` | `--full-auto` | `--sandbox_config_dir` |

**Notes:**
- Claude uses `ultrathink` as a prompt prefix to trigger extended thinking, not a CLI flag.
- Codex receives its system prompt as a `codex.md` file written to a config directory, loaded via `--instructions`.
- Gemini reads both its system prompt (`GEMINI.md`) and MCP config (`settings.json`) from a `.gemini/` directory. The `--sandbox_config_dir` flag points to the parent of that directory.

---

## Lifecycle

1. **On-demand spawn.** CLI agents start when they are assigned a task, not when the plugin activates. This means a CLI member will show as "not started" until work is routed to it.

2. **System prompt injection.** The agent receives the full team context (role, goal, team directory, decision flow, learnings) via its CLI-specific prompt mechanism.

3. **MCP tool access.** The agent accesses team tools (`team_task`, `team_send`, `team_memory`, `team_inbox`, `team_run`) through an MCP bridge process that communicates with the plugin's IPC server over a Unix socket.

4. **Task completion.** The agent is instructed to call `team_task(action: "update", status: "COMPLETED")` when done. If it exits without doing so, the crash handler takes over:
   - **Exit code 0:** Orphaned WORKING tasks are auto-completed with a summary from the log tail.
   - **Exit code != 0:** WORKING tasks are marked FAILED, a learning is captured, and the orchestrator is notified via `team_send`.

---

## Architecture

```
CLI Process (claude/codex/gemini)
    |
    | stdio
    v
MCP Bridge (node process: mcp-bridge.js)
    |
    | Unix socket JSON-RPC
    v
Plugin IPC Server (ipc-server.ts)
    |
    | Direct function calls
    v
Tool Factories (team_task, team_send, etc.)
    |
    v
State Stores (RunManager, KvStore, MessageStore, etc.)
```

The MCP bridge is a separate Node.js process that translates MCP protocol into JSON-RPC calls over the Unix socket at `{stateDir}/ipc.sock`. Each CLI agent gets its own MCP bridge instance with its agent ID baked in.

---

## Debugging

### Commands

| Command | Description |
|---------|-------------|
| `/team agents` | Show status of all CLI agents (running, exited, pid, uptime) |
| `/team logs <team/member>` | Get the log file path for a specific CLI agent |
| `/team start <team/member>` | Manually spawn a CLI agent (useful for debugging) |
| `/team stop-agent <team/member>` | Kill a running CLI agent process |

### Log files

Each CLI agent streams its PTY output to a log file at:
```
{stateDir}/logs/{team}/{member}.log
```

To watch a CLI agent's output in real time:
```bash
tail -f "$(openclaw config get state_dir)/logs/dev-team/claude-worker.log"
```

---

## Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| `node-pty is required for CLI agent support` | node-pty not installed | Run `npm install node-pty` in the plugin directory |
| `spawn claude ENOENT` or similar | CLI binary not found in PATH | Verify with `which claude`. The spawner searches the login shell PATH, `/usr/local/bin`, `/opt/homebrew/bin`, and `~/.local/bin`. |
| Agent shows "not started" in `/team agents` | Normal -- CLI agents spawn on-demand | Assign a task to the member and it will start automatically |
| `MCP bridge not found` | Plugin not built or bridge script missing | Run `npm run build` in the plugin directory |
| Agent spawns but no tool calls appear | IPC socket path mismatch or bridge crash | Check the agent's log file for errors. Verify `{stateDir}/ipc.sock` exists. |
| Agent exits immediately with code 1 | CLI tool configuration issue (auth, permissions) | Run the CLI tool manually (`claude -p "hello"`) to verify it works standalone |
| Tasks stuck in WORKING after agent exits | Clean exit handler didn't fire | Check if the process was killed with SIGKILL (bypasses exit handler). Use `/team stop-agent` which sends SIGTERM. |

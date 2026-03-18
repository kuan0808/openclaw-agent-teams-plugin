# Troubleshooting

Organized by symptom: config errors, runtime errors, CLI agent issues, and state inspection.

---

## Config Validation Errors

These errors appear at plugin activation. The plugin disables itself if any are present.

| Error Message | Cause | Fix |
|---------------|-------|-----|
| `Config must be an object` | Plugin config is null/undefined/non-object | Ensure `pluginConfig` is a JSON object |
| `Config must have a 'teams' object` | Missing `teams` key | Add `"teams": { ... }` to config |
| `Team "X": missing or invalid 'description'` | Team missing description | Add `"description": "..."` to team |
| `Team "X": 'coordination' must be "orchestrator" or "peer"` | Invalid or missing coordination | Set to `"orchestrator"` or `"peer"` |
| `Team "X": orchestrator mode requires an 'orchestrator' field` | Orchestrator mode without orchestrator member | Add `"orchestrator": "<member-key>"` |
| `Team "X": orchestrator "Y" is not listed in members` | Orchestrator key doesn't match any member | Use a key that exists in `members` |
| `Team "X": missing or invalid 'members' object` | No members object | Add `"members": { ... }` |
| `Team "X": must have at least one member` | Empty members object | Add at least one member |
| `Team "X", member "Y": must be an object` | Member value is not an object | Make member value a `{ "role": "..." }` object |
| `Team "X", member "Y": must have 'role' or 'role_file'` | Member missing role | Add `"role": "..."` or `"role_file": "./path.md"` |
| `Team "X", member "Y": 'cli' must be one of claude, codex, gemini` | Invalid CLI type | Use `"claude"`, `"codex"`, or `"gemini"` |
| `Team "X", member "Y": 'cli_options.cwd' must be a string` | Invalid cwd type | Set `cwd` to a string path |
| `Team "X", member "Y": 'cli_options.extra_args' must be an array` | Invalid extra_args type | Set `extra_args` to an array of strings |
| `Team "X", member "Y": tools.allow must include "team_run" for Agent Teams to work` | `tools.allow` is set but missing a core team tool | All 5 core tools (`team_run`, `team_task`, `team_memory`, `team_send`, `team_inbox`) must be in `allow` |
| `Team "X", member "Y": tools.deny must not block "team_run"` | `tools.deny` blocks a core team tool | Remove core team tools from `deny` — they are required for Agent Teams |
| `Team "X", member "Y": native orchestrators must include "sessions_spawn" in tools.allow` | Orchestrator member has `tools.allow` without `sessions_spawn` | Add `"sessions_spawn"` to orchestrator's `tools.allow` |

---

## Runtime Errors

### Run Management

| Symptom | Cause | Fix |
|---------|-------|-----|
| `No active run for team "X"` | Calling task/complete/cancel without starting a run | Call `team_run(action: "start", goal: "...")` first |
| `Failed to complete run` | Run already completed/canceled | Check run status with `team_run(action: "status")` |
| `Failed to cancel run` | Run already completed/canceled | Check run status first |

### Task Management

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Task "X" not found` | Invalid task_id | Query tasks: `team_task(action: "query")` |
| Task stuck in BLOCKED | Dependencies not completed | Check dependent tasks: `team_task(action: "query", filter_status: ["BLOCKED"])` |
| `Gate blocked: ... requires at least one deliverable` | Gate requires deliverables before transition | Add deliverables to the task update |
| `Gate blocked: ... requires a result summary` | Gate requires result before transition | Add `result` parameter to the update |
| `Gate blocked: only "X" can transition tasks to Y` | Wrong agent trying to approve | Have the designated approver make the transition |

### Messaging

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Member "X" not found in team` | Sending to non-existent member | Check member names with `/team list` or `/team status` |
| `At least one of 'to' or 'topic' must be provided` | Neither `to` nor `topic` specified | Add `to` for direct message or `topic` for event |
| `Cannot use 'topic' with source='activity'` | Conflicting parameters | Use `filter_type`/`filter_agent` for activity queries |

### Memory

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Parameter 'key' is required` | Missing key for get/set/delete | Provide the `key` parameter |
| `Parameter 'value' is required` | Missing value for set | Provide the `value` parameter |
| `Unknown store: X` | Invalid store name | Use `"kv"` or `"docs"` |

---

## CLI Agent Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| CLI agent not starting | node-pty not installed | Install node-pty: `npm install node-pty` |
| CLI agent crashes immediately | Invalid CLI type or missing CLI binary | Verify the CLI tool is installed (`claude`, `codex`, or `gemini`) |
| Agent shows "not started" | CLI agents spawn on-demand | Assign a task to the agent, or use `/team start <team/member>` |
| Agent shows "exited" | Process terminated | Check logs: `/team logs <team/member>`, then restart with `/team start` |

### CLI Agent Commands

```bash
# Check all CLI agent status
/team agents

# View agent logs
/team logs my-team/claude-dev
# Then in a terminal:
tail -f <log-path>

# Manually start/stop
/team start my-team/claude-dev
/team stop-agent my-team/claude-dev
```

---

## State Inspection

### File Locations

State files are stored under the path resolved by your OpenClaw runtime's `resolveStateDir()`, in `plugins/agent-teams/`:

```
<state-dir>/plugins/agent-teams/
├── broadcast.jsonl          # Real-time event stream
├── ipc.sock                 # CLI agent IPC socket (if CLI agents configured)
├── kv/
│   └── <team>.json          # Key-value store per team
├── events/
│   └── <team>.json          # Event queue per team
├── docs/
│   └── <team>/              # Document pool per team
├── runs/
│   └── <team>/              # Run & task state per team
├── messages/
│   └── <team>/              # Direct messages per team
├── activity/
│   └── <team>/              # Activity log per team
└── logs/
    └── <team>/
        └── <member>.log     # CLI agent logs
```

### Quick Diagnostics

**Monitor all events in real-time:**
```bash
tail -f <state-dir>/plugins/agent-teams/broadcast.jsonl | jq
```

**Query recent activity:**
```
team_inbox(source: "activity", limit: 20)
```

**Check for failed tasks:**
```
team_task(action: "query", filter_status: ["FAILED"])
```

**Check for blocked tasks:**
```
team_task(action: "query", filter_status: ["BLOCKED"])
```

**List all event topics:**
```
team_inbox(action: "list_topics")
```

**Check team memory keys:**
```
team_memory(action: "list")
team_memory(action: "list", store: "docs")
```

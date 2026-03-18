# Tool Reference

Complete parameter documentation for the 5 Agent Teams tools.

---

## team_run

Manage team execution runs. A run represents a goal the team is working towards.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | `"start" \| "status" \| "complete" \| "cancel"` | Yes | Run lifecycle action |
| `team` | string | No | Team name (auto-resolved for `at--` agents) |
| `run_id` | string | No | Run ID (required for complete/cancel with concurrent runs, auto-resolved from session otherwise) |
| `goal` | string | For `start` | Goal for the run |
| `result` | string | No | Result summary (for `complete`) |
| `reason` | string | No | Cancellation reason (for `cancel`) |

### Actions

**`start`** — Creates a new run.
- Requires `goal`
- If the team has a workflow template, auto-generates a chain of tasks (one per stage)
- Returns `run_id`, `status`, `orchestrator`, and `workflow_tasks` (if template used)

**`status`** — Returns current run state.
- Returns `run_id`, `status`, `goal`, `orchestrator`, `started_at`, task counts by status
- If no active run: `{ status: "no_active_run" }`

**`complete`** — Marks the run as completed.
- Optional `result` summary
- Collects all learnings from KV store
- Returns `status` and `learnings` array

**`cancel`** — Cancels the run and all non-completed tasks.
- Optional `reason`
- Returns `status` and `tasks_canceled` count

---

## team_task

Create, update, and query tasks within a team run. Supports skill-based routing, dependency management, deliverables tracking, and approval gates.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | `"create" \| "update" \| "query"` | Yes | Task action |
| `team` | string | No | Team name (auto-resolved for `at--` agents) |
| `description` | string | For `create` | Task description |
| `assign_to` | string | No | Directly assign to a specific member |
| `required_skills` | string[] | No | Skills needed for routing |
| `depends_on` | string[] | No | Task IDs this task depends on |
| `task_id` | string | For `update` | Task ID to update |
| `status` | TaskState | No | New status for update |
| `result` | string | No | Task result (for update) |
| `message` | string | No | Status message (for update) |
| `filter_status` | string[] | No | Filter tasks by status (for query) |
| `filter` | `"mine" \| "unassigned" \| "available"` | No | Filter tasks: `mine` (assigned to me), `unassigned` (no assignee), `available` (PENDING tasks I could claim) |
| `deliverables` | Deliverable[] | No | Deliverables to register |
| `learning` | Learning | No | Structured learning to capture |

### Deliverable Object

```json
{
  "type": "file | url | artifact | doc",
  "path": "/path/to/file",
  "url": "https://...",
  "doc_key": "doc-pool-key",
  "description": "What this deliverable is"
}
```

Only include the relevant field for the type: `path` for `file`, `url` for `url`, `doc_key` for `doc`.

### Learning Object

```json
{
  "content": "What was learned",
  "confidence": 0.8,
  "category": "failure | pattern | fix | insight"
}
```

- `confidence` — 0.0 to 1.0 (default: 0.7)
- `category` — defaults to `"failure"` for FAILED tasks, `"insight"` otherwise

### Actions

**`create`** — Creates a task in the current run.
- Requires an active run (start one first with `team_run`)
- Routes via 3-layer system: direct (`assign_to`) → skill match (`required_skills`) → fallback
- If `depends_on` includes incomplete tasks, status starts as `BLOCKED`; otherwise `PENDING`
- If assigned to a CLI agent, spawns the agent on-demand
- Returns `task_id`, `assigned_to`, `status`, `routing_reason`

**`update`** — Updates task status, result, deliverables, or learning.
- Requires `task_id`
- **Gate enforcement**: If `workflow.gates` is configured, transitions are validated:
  - `require_deliverables` — At least one deliverable must exist
  - `require_result` — Result summary must be provided
  - `approver` — Only the specified member can make this transition
- **Auto-learning**: On `COMPLETED`/`FAILED`, a learning is auto-captured if:
  - Explicit `learning` parameter provided → used as-is
  - `FAILED` + `message` → auto-generates failure learning (confidence: 0.5)
  - `COMPLETED` + `result` (>50 chars) → auto-generates insight learning (confidence: 0.5)
- **Dependency resolution**: On `COMPLETED`, any tasks with `depends_on` containing this task ID are unblocked (`BLOCKED` → `PENDING`)
- **Fail-loopback**: On `FAILED` with a workflow template, creates a rework task at the target stage and re-blocks downstream
- Returns `task_id`, `status`, `assigned_to`, `result`, `message`, `unblocked_tasks`, `fail_loopback`, `learning_captured`

**`query`** — Lists tasks in the current run.
- Optional `filter_status` to filter by status
- Returns array of tasks with all fields including `deliverables_count` and `workflow_stage`

---

## team_memory

Read and write shared team memory. Two stores available:

- **KV Store** — For ephemeral data, counters, flags, configuration
- **Document Pool** — For larger content: markdown, data files, reports

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | `"get" \| "set" \| "delete" \| "list"` | Yes | Memory action |
| `team` | string | No | Team name (auto-resolved for `at--` agents) |
| `store` | `"kv" \| "docs"` | No | Target store (default: `"kv"`) |
| `key` | string | For get/set/delete | Key name |
| `value` | string | For set | Value to store. For KV: JSON-stringified value. For docs: raw content string. |
| `ttl` | number | No | Time-to-live in seconds (KV store only) |
| `content_type` | string | No | Content type for docs (e.g. `"text/markdown"`, default: `"text/plain"`) |

### KV Store Behavior

- Values are auto-parsed as JSON; if parsing fails, stored as plain string
- `list` action filters out internal `learnings:*` keys
- TTL is optional — entries without TTL never expire
- Returns `found`, `key`, `value`, `written_by`, `ttl_remaining`

### Document Pool Behavior

- Stores raw content strings with a content type
- Good for large text, markdown reports, CSV data
- Returns `found`, `key`, `content`, `content_type`, `written_by`, `size_bytes`

---

## team_send

Send messages to team members or publish events to the team event queue.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `team` | string | No | Team name (auto-resolved for `at--` agents) |
| `to` | string | No* | Target member name, or `"all"` for broadcast |
| `message` | string | Yes | Message content |
| `topic` | string | No* | Publish to this event queue topic |
| `data` | string | No | JSON data payload for event queue messages |

*At least one of `to` or `topic` must be provided. Both can be used together.

### Direct Messaging (`to`)

- `to: "member-name"` — Send to a specific member's inbox
- `to: "all"` — Broadcast to all other members' inboxes
- Validates that the target member exists in the team

### Event Publishing (`topic`)

- Publishes to the team's event queue under the given topic
- `data` is JSON-parsed; if parsing fails, stored as plain string
- Other members subscribe via `team_inbox(topic: "...")`
- Can combine with `to` to both publish an event AND send a direct message

---

## team_inbox

Read messages from your inbox, subscribe to event queue topics, or query the activity log.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `team` | string | No | Team name (auto-resolved for `at--` agents) |
| `source` | `"inbox" \| "events" \| "activity"` | No | Data source (default: `"inbox"`, or `"events"` if `topic` is provided) |
| `limit` | number | No | Max messages to return (default: 10) |
| `ack` | boolean | No | Mark messages as read (default: true) |
| `topic` | string | No | Event queue topic to read from |
| `since` | string | No | ISO timestamp — only return entries after this time |
| `action` | `"read" \| "list_topics"` | No | `"list_topics"` to discover available event topics |
| `filter_type` | string | No | Filter by activity type (activity source only) |
| `filter_agent` | string | No | Filter by member name (activity source only) |

### Source: inbox (default)

Reads direct messages from other team members.
- Messages are marked as read (`ack: true`) by default
- Returns `source: "inbox"`, `member`, `team`, `count`, `messages`

### Source: events

Reads from the event queue. Triggered implicitly when `topic` is provided.
- `topic: "*"` reads from all topics
- `since` filters events by timestamp
- Returns `source: "event_queue"`, `topic`, `team`, `count`, `events`

### Source: activity

Queries the system activity log.
- Cannot be combined with `topic`
- `filter_type` — Filter by activity type. Valid types:
  `task_created`, `task_updated`, `task_completed`, `task_failed`,
  `task_canceled`, `task_revision_requested`, `task_revision_restarted`,
  `run_started`, `run_completed`, `run_canceled`, `run_timeout`,
  `run_max_rounds_exceeded`, `message_sent`, `memory_updated`,
  `deliverable_added`, `dependency_resolved`, `dependency_blocked`,
  `dependency_cascaded`, `learning_captured`, `requester_notified`,
  `workflow_stage_advanced`, `workflow_fail_loopback`
- `filter_agent` — Filter by member name
- Returns `source: "activity"`, `team`, `count`, `entries`

### Action: list_topics

Discovers available event queue topics:
```
team_inbox(action: "list_topics")
→ { topics: ["status-update", "code-review", ...] }
```

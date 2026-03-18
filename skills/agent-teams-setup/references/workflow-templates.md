# Workflow Templates

Advanced workflow features: templates, fail handlers, gates, deliverables, and structured learnings.

---

## Template Structure

A workflow template defines a series of stages that auto-generate tasks when a run starts.

```json
{
  "workflow": {
    "template": {
      "stages": [
        { "name": "design", "role": "designer", "skills": ["design"] },
        { "name": "implement", "role": "developer", "skills": ["coding"] },
        { "name": "test", "role": "qa", "skills": ["testing"] },
        { "name": "review", "role": "reviewer", "skills": ["review"] }
      ],
      "fail_handlers": {
        "test": "implement",
        "review": "design"
      }
    }
  }
}
```

### Stage Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Stage identifier (used in task IDs and loopback) |
| `role` | string | No | Role name — matched against member keys or role descriptions |
| `skills` | string[] | No | Skills used for routing if role match fails |

### How Task Chain Generation Works

When `team_run(action: "start")` is called with a workflow template:

1. Each stage becomes a task with ID `task-<run_id>-stage-<name>`
2. Task description: `[<stage-name>] <goal>`
3. First stage starts as `PENDING`; all subsequent stages start as `BLOCKED`
4. Each stage `depends_on` the previous stage's task ID
5. Assignment uses priority: role match → skill match → fallback routing

### Role Matching Priority

When resolving a stage's `role` to a member:

1. **Exact key match** — Member key equals role (case-insensitive)
2. **Exact role match** — Member's `role` field equals the stage role
3. **Prefix key match** — Member key starts with the role
4. **Prefix role match** — Member's `role` field starts with the role

---

## Fail Handlers (Loopback)

Fail handlers define what happens when a stage fails. They create a "rework" task at an earlier stage and re-block all downstream stages.

```json
{
  "fail_handlers": {
    "review": "implement",
    "implement": "design"
  }
}
```

This means:
- If `review` fails → create rework task at `implement` stage
- If `implement` fails → create rework task at `design` stage

### Loopback Mechanics

When a task with `workflow_stage` transitions to `FAILED`:

1. Look up `fail_handlers[failed_stage]` to find the target stage
2. Create a rework task:
   - ID: `task-<run_id>-rework-<target_stage>-<timestamp>`
   - Description: `[<target_stage> - rework] <original_goal> (Failure reason: <message>)`
   - Status: `PENDING`
   - Assigned to: the member who was originally assigned to the target stage
3. Re-block all downstream stage tasks (those after the target stage):
   - Status set back to `BLOCKED`
   - Message: `Re-blocked: upstream stage "<failed_stage>" failed`

### Example Flow

```
1. Run starts → tasks: design(PENDING) → implement(BLOCKED) → review(BLOCKED)
2. design completes → implement unblocked (PENDING)
3. implement completes → review unblocked (PENDING)
4. review FAILS →
   a. Rework task created: implement-rework (PENDING)
   b. (no downstream to re-block since review is the last stage)
5. implement-rework completes → review would need to be re-triggered
```

---

## Gates

Gates enforce quality requirements on task status transitions.

```json
{
  "workflow": {
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

### Gate Config Fields

| Field | Type | Description |
|-------|------|-------------|
| `require_deliverables` | boolean | At least one deliverable must be attached to the task |
| `require_result` | boolean | A `result` string must be provided |
| `approver` | string | Only this member can transition to COMPLETED |
| `reviewer` | string | Only this member (or `"orchestrator"`) can transition to REVISION_REQUESTED |

### Approver / Reviewer

- `"orchestrator"` — Resolves to the team's configured orchestrator member
- Any member name — Only that specific member can approve/review
- The leader agent (`__leader__`) always bypasses approver checks

### REVISION_REQUESTED Behavior

- Each revision request **increments `round_count`**, counting toward `max_rounds` enforcement
- Only **leaf tasks** (tasks with no active non-terminal dependents) can be sent for revision
- The `reviewer` gate field controls who can request revisions (defaults to orchestrator in orchestrator mode)

### Gate Error Messages

When a gate blocks a transition, the error clearly states what's missing:

- `Gate blocked: transitioning to COMPLETED requires at least one deliverable.`
- `Gate blocked: transitioning to COMPLETED requires a result summary.`
- `Gate blocked: only "pm" can transition tasks to COMPLETED.`

---

## Deliverables

Deliverables are artifacts attached to tasks. 4 types supported:

| Type | Key Field | Description |
|------|-----------|-------------|
| `file` | `path` | A file path (relative or absolute) |
| `url` | `url` | A URL (PR link, deployed URL, etc.) |
| `artifact` | `description` | A named artifact (build output, etc.) |
| `doc` | `doc_key` | A key in the team's document pool |

### Registering Deliverables

Add deliverables when updating a task:

```
team_task(
  action: "update",
  task_id: "task-123",
  status: "COMPLETED",
  result: "API endpoint implemented and tested",
  deliverables: [
    { "type": "file", "path": "src/api/users.ts", "description": "User API endpoint" },
    { "type": "url", "url": "https://github.com/org/repo/pull/42", "description": "Pull request" },
    { "type": "doc", "doc_key": "api-spec", "description": "API specification" }
  ]
)
```

Each deliverable is stamped with `created_by` (the calling agent) and `created_at` (timestamp).

---

## Structured Learnings

Learnings capture knowledge from task outcomes for future reference.

### Explicit Learnings

Provide a learning object when updating a task:

```
team_task(
  action: "update",
  task_id: "task-123",
  status: "COMPLETED",
  learning: {
    "content": "React Query v5 requires wrapping mutations in useMutation hook",
    "confidence": 0.9,
    "category": "pattern"
  }
)
```

### Auto-Captured Learnings

When no explicit learning is provided:

- **On FAILED + message**: Auto-captures a `failure` learning with confidence 0.5
  - Content: `Task "<description>" failed: <message>`
- **On COMPLETED + result (>50 chars)**: Auto-captures an `insight` learning with confidence 0.5
  - Content: `Completed "<description>": <result>`

### Learning Categories

| Category | When to Use |
|----------|------------|
| `failure` | Something went wrong — captures what failed and why |
| `pattern` | A reusable pattern was discovered |
| `fix` | A specific fix for a known issue |
| `insight` | General knowledge gained from the task |

### Storage

Learnings are stored in two places:
1. **On the task** — `task.learning` field
2. **In KV store** — Key `learnings:<category>:<task_id>` for cross-run persistence

The KV learning keys are hidden from `team_memory(action: "list")` to keep the user-facing key list clean. They persist based on the team's `knowledge.retention` setting (`"across-runs"` by default).

### Consolidation

When `knowledge.consolidation` is enabled (default: `true`):
- Learnings are consolidated at the end of each run
- If `notify_leader` is `true`, the orchestrator/leader is notified of new learnings

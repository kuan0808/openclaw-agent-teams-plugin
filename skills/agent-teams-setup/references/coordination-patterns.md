# Coordination Patterns

Deep dive into orchestrator vs peer coordination modes, routing, and anti-patterns.

---

## Orchestrator Mode

One designated member (the orchestrator) coordinates the entire team. All other members are workers.

### How it works

The orchestrator follows a "delegate, don't do" pattern:

1. **Decompose** the goal into discrete tasks with clear acceptance criteria
2. **Assign** tasks via `team_task(action: "create", assign_to: "member")`, matching work to member skills
3. **Activate** assigned members by executing the `sessions_send(...)` calls returned in the `REQUIRED_ACTION` response
4. **Monitor** progress with `team_task(action: "query")` and `team_inbox`
5. **Review** deliverables when tasks complete. Accept or request revisions.
6. **Complete** the run with `team_run(action: "complete", result: "...")` when all work meets the bar

### Quality control with REVISION_REQUESTED

The orchestrator can send work back for revision:

```
team_task(action: "update", task_id: "...",
  status: "REVISION_REQUESTED",
  message: "Specific feedback on what needs to change")
```

Both revisions and fail-loopbacks increment `round_count` on the run. When `round_count` reaches `max_rounds`, the enforcement system cancels the run and all non-terminal tasks.

### Auto-complete

If the orchestrator does not manually complete the run within 60 seconds after all tasks reach a terminal state (COMPLETED, FAILED, or CANCELED), the system auto-completes it. The 60-second grace period gives the orchestrator time to review final results and write a synthesis. After that window, the plugin consolidates task results and completes the run automatically.

### Best for

- Structured workflows with sequential stages
- Quality gates and approval requirements
- Human-in-the-loop scenarios (orchestrator reviews before accepting)
- Complex projects requiring centralized coordination

---

## Peer Mode

All members are equal collaborators. There is no designated leader.

### How it works

Each peer follows a "check first, then act" pattern:

1. **CHECK FIRST** -- call `team_task(action: "query")` and `team_inbox` before doing anything to see what already exists
2. **Create tasks** for gaps in coverage. Assign each task to the best-suited peer (including yourself). Keep tasks small with one concrete deliverable each.
3. **ACTIVATE** peers by executing the `sessions_send(...)` calls in each `REQUIRED_ACTION` response
4. **Work** on assigned tasks. Use `team_memory` to share results and `team_send` to coordinate.
5. **Complete** tasks with `team_task(action: "update", status: "COMPLETED", result: "...")`.

### Auto-complete

Peer-mode runs auto-complete immediately when all tasks reach a terminal state. There is no grace period -- once every task is COMPLETED, FAILED, or CANCELED, the run closes. No member needs to call `team_run(action: "complete")`.

### Self-organization

Peers self-organize through skill-based routing and load balancing. When a task is created without an explicit `assign_to`, the router matches `required_skills` against member `skills[]` arrays and picks the best fit with the least active workload.

### Best for

- Parallel work across clear skill domains
- Autonomous agents that can self-direct
- Small teams (2-5 members) with minimal coordination overhead
- Flat collaboration without approval gates

---

## Decision Matrix

| Factor | Orchestrator | Peer |
|--------|-------------|------|
| Approval needed | Yes -- orchestrator reviews | No -- self-review |
| Clear hierarchy | Yes -- one leader, N workers | No -- flat structure |
| Sequential stages | Yes -- workflow templates with stage gates | Parallel preferred |
| Team size | Any size | 2-5 members (larger gets noisy) |
| Quality control | REVISION_REQUESTED flow | Self-review by assignee |
| Human in the loop | Yes -- orchestrator as quality gate | Minimal oversight |
| Auto-completion | 60-second grace period after all tasks terminal | Immediate on all tasks terminal |
| Run finalization | Orchestrator writes synthesis | System consolidates results |

---

## Routing Algorithm

Task routing uses a 3-layer cascade. The first layer that produces a match wins.

### Layer 1: Direct Assignment

```
team_task(action: "create", assign_to: "alice", ...)
```

When `assign_to` is specified, the task goes directly to that member. No routing logic runs.

### Layer 2: Skill-Based Matching

```
team_task(action: "create", required_skills: ["security", "review"], ...)
```

The router compares `required_skills` against each member's `skills[]` array:

1. **Exact match** -- members who have all required skills. If multiple exact matches exist, the router load-balances by picking the member with the fewest active tasks (PENDING + WORKING count).
2. **Best-fit match** -- members who have the most overlap with required skills. Among the top tier (same overlap count), load-balances by least active tasks.

### Layer 3: Fallback

If no skill match is found:

- **Orchestrator mode:** Falls back to the orchestrator member.
- **Peer mode:** Falls back to the caller (the member creating the task), or if the caller is not a team member, load-balances across all members.

---

## Anti-Patterns

**Too many members (>5):** Coordination overhead grows faster than throughput. Messages multiply, routing becomes noisy, and agents spend more time reading inbox than working. Split into smaller focused teams instead.

**Missing skills tags:** Without `skills[]` on members, all routing falls to the fallback layer. Skill-based assignment is the primary mechanism for getting the right work to the right agent -- define skills for every member.

**Unclear roles:** When member roles overlap significantly, agents duplicate each other's work. Each member should have a distinct area of responsibility, reflected in both `role` and `skills`.

**Orchestrator doing implementation:** The orchestrator's job is coordination -- decompose, assign, review. If the orchestrator writes code or produces deliverables, it becomes a bottleneck and workers sit idle. Delegate everything.

**Peer mode without CHECK FIRST:** If peers create tasks without first checking what exists (`team_task(action: "query")`), they produce duplicate tasks for the same work. The CHECK FIRST step is critical in peer mode.

**No activation after task creation:** Creating a task does not automatically wake the assigned agent. Every `team_task(create)` response includes a `REQUIRED_ACTION` with `sessions_send(...)` calls. Skipping these means the assigned agent never starts working.

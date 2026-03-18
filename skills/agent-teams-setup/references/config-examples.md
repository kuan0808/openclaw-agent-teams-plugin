# Config Examples

6 ready-to-use team configurations, ready to apply directly.

All examples show the `pluginConfig` content for the `agent-teams` plugin.

### How to Apply Any Example

Replace `<JSON>` with the config block (on one line, properly escaped):

```bash
openclaw config set plugins.entries.agent-teams.config --strict-json '<JSON>'
openclaw gateway restart
```

---

## 1. Solo Developer (Minimal)

The simplest possible configuration — one peer agent.

```json
{
  "teams": {
    "solo": {
      "description": "Solo developer assistant",
      "coordination": "peer",
      "members": {
        "dev": {
          "role": "Full-stack developer. Handles coding, debugging, testing, and documentation."
        }
      }
    }
  }
}
```

**When to use:** Getting started, or when you just need one agent with team tools (shared memory, activity logging, run tracking).

---

## 2. Code Review Pair

Two peer agents with complementary review focus areas.

```json
{
  "teams": {
    "reviewers": {
      "description": "Code review pair with complementary perspectives",
      "coordination": "peer",
      "members": {
        "arch-reviewer": {
          "role": "Reviews code for architecture, design patterns, maintainability, and API design. Focuses on structural concerns.",
          "skills": ["review", "architecture", "design-patterns"]
        },
        "sec-reviewer": {
          "role": "Reviews code for security vulnerabilities, performance bottlenecks, error handling, and edge cases.",
          "skills": ["review", "security", "performance", "testing"]
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

**When to use:** Code review workflows where you want multiple perspectives. Tasks route to the reviewer whose skills best match the review type.

---

## 3. Product Team (Orchestrator)

Classic team with a PM orchestrating frontend, backend, and QA members.

```json
{
  "teams": {
    "product": {
      "description": "Product development team with PM-led coordination",
      "coordination": "orchestrator",
      "orchestrator": "pm",
      "members": {
        "pm": {
          "role": "Project manager. Breaks down goals into tasks, assigns work to team members, reviews deliverables, and ensures quality. You coordinate the team — never do implementation work yourself.",
          "can_delegate": true
        },
        "frontend": {
          "role": "Frontend developer. Expert in React, TypeScript, CSS, and UI/UX implementation. Build user interfaces and handle client-side logic.",
          "skills": ["frontend", "react", "typescript", "css", "ui"]
        },
        "backend": {
          "role": "Backend developer. Expert in Node.js, APIs, databases, and server architecture. Build endpoints, data models, and business logic.",
          "skills": ["backend", "api", "database", "nodejs", "server"]
        },
        "qa": {
          "role": "QA engineer. Write and run tests, validate implementations against requirements, report bugs with clear reproduction steps.",
          "skills": ["testing", "qa", "validation", "e2e"]
        }
      },
      "workflow": {
        "max_rounds": 15,
        "timeout": 900
      }
    }
  }
}
```

**When to use:** Structured development where you want a PM to coordinate. The PM creates tasks and assigns them; skill-based routing handles the matching.

---

## 4. CLI Agent Team (Mixed)

Combine native OpenClaw agents with external CLI agents.

```json
{
  "teams": {
    "hybrid": {
      "description": "Hybrid team with native orchestrator and CLI workers",
      "coordination": "orchestrator",
      "orchestrator": "lead",
      "members": {
        "lead": {
          "role": "Team lead. Coordinates work, reviews results, makes architectural decisions.",
          "can_delegate": true
        },
        "claude-dev": {
          "role": "Developer using Claude CLI for implementation tasks",
          "skills": ["coding", "implementation", "refactoring"],
          "cli": "claude",
          "cli_options": {
            "cwd": "./src",
            "thinking": true
          }
        },
        "codex-dev": {
          "role": "Developer using Codex CLI for rapid prototyping",
          "skills": ["coding", "prototyping", "scripts"],
          "cli": "codex",
          "cli_options": {
            "cwd": "./experiments"
          }
        }
      }
    }
  }
}
```

**When to use:** Leveraging multiple AI CLI tools, each in their own working directory. The native orchestrator coordinates while CLI agents do the implementation.

**Notes:**
- CLI agents spawn on-demand when assigned tasks
- Use `/team agents` to check CLI agent status
- Use `/team logs hybrid/claude-dev` to view agent logs

---

## 5. Pipeline Team (Workflow Template)

Orchestrator with a 3-stage pipeline, fail handlers, and gates.

```json
{
  "teams": {
    "pipeline": {
      "description": "Staged pipeline: design → implement → review with quality gates",
      "coordination": "orchestrator",
      "orchestrator": "pm",
      "members": {
        "pm": {
          "role": "Pipeline manager. Starts runs, monitors progress, approves completed work.",
          "can_delegate": true
        },
        "designer": {
          "role": "System designer. Creates technical designs, API specs, and architecture documents.",
          "skills": ["design", "architecture", "api-design"]
        },
        "developer": {
          "role": "Implementation developer. Writes code according to designs, creates tests.",
          "skills": ["coding", "implementation", "testing"]
        },
        "reviewer": {
          "role": "Code reviewer. Reviews implementations for correctness, security, and quality.",
          "skills": ["review", "security", "quality"]
        }
      },
      "workflow": {
        "max_rounds": 20,
        "timeout": 1200,
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
      },
      "knowledge": {
        "retention": "across-runs",
        "consolidation": true,
        "notify_leader": true
      }
    }
  }
}
```

**When to use:** Structured software development with stage gates. If review fails, work loops back to implementation automatically.

**How it works:**
1. `team_run(action: "start")` auto-generates 3 tasks: design → implement → review
2. Each stage is assigned via role matching
3. Later stages are BLOCKED until earlier ones complete
4. If review FAILS, a rework task is created at the implement stage and review is re-blocked
5. COMPLETED transitions require deliverables + result + orchestrator approval

---

## 6. Full-Featured Team

Every optional field demonstrated.

```json
{
  "teams": {
    "full": {
      "description": "Full-featured team demonstrating all configuration options",
      "coordination": "orchestrator",
      "orchestrator": "lead",
      "shared_memory": {
        "enabled": true,
        "stores": {
          "kv": { "max_entries": 500, "ttl": 7200 },
          "events": { "max_backlog": 1000 },
          "docs": { "max_size_mb": 50, "allowed_types": ["text", "json", "csv"] }
        }
      },
      "members": {
        "lead": {
          "role_file": "./roles/lead.md",
          "can_delegate": true,
          "model": { "primary": "claude-sonnet-4-20250514" }
        },
        "specialist": {
          "role": "Domain specialist handling complex analysis",
          "skills": ["analysis", "research", "data"],
          "model": { "primary": "claude-opus-4-20250514" }
        },
        "fast-worker": {
          "role": "Fast implementation agent for straightforward tasks",
          "skills": ["coding", "scripts", "automation"],
          "model": { "primary": "claude-haiku-4-5-20251001" }
        },
        "external": {
          "role": "External CLI agent for isolated work",
          "skills": ["coding", "testing"],
          "cli": "claude",
          "cli_options": {
            "cwd": "./sandbox",
            "thinking": true,
            "verbose": false,
            "extra_args": ["--max-turns", "20"]
          }
        }
      },
      "workflow": {
        "max_rounds": 25,
        "timeout": 1800,
        "template": {
          "stages": [
            { "name": "analyze", "role": "specialist", "skills": ["analysis"] },
            { "name": "implement", "skills": ["coding"] },
            { "name": "test", "skills": ["testing"] }
          ],
          "fail_handlers": {
            "test": "implement"
          }
        },
        "gates": {
          "COMPLETED": {
            "require_deliverables": true,
            "require_result": true,
            "approver": "orchestrator"
          }
        }
      },
      "knowledge": {
        "consolidation": true,
        "retention": "across-runs",
        "notify_leader": true
      }
    }
  }
}
```

**Notes:**
- `role_file` loads the role description from an external markdown file
- `model.primary` sets the preferred model for the agent
- Different members can use different model tiers for cost optimization
- `cli_options.extra_args` is an escape hatch for additional CLI flags

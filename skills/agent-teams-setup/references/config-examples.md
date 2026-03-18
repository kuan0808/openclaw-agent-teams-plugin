# Config Examples

8 ready-to-use team configurations across 4 categories. Copy any JSON block and apply directly.

### How to Apply

```bash
openclaw config set plugins.entries.agent-teams.config --strict-json '<JSON>'
# Then /reset (or open a new chat) to activate — gateway auto-restarts on config changes
```

### Table of Contents

| # | Template | Mode | Members | Category |
|---|----------|------|:-------:|----------|
| 1 | [Solo Developer](#1-solo-developer) | peer | 1 | Development |
| 2 | [Co-Reviewer](#2-co-reviewer) | peer | 3 | Development |
| 3 | [Product Team](#3-product-team) | orchestrator | 4 | Development |
| 4 | [Pipeline](#4-pipeline) | orchestrator | 4 | Development |
| 5 | [Research Team](#5-research-team) | peer | 3 | Research & Analysis |
| 6 | [Competitive Analysis](#6-competitive-analysis) | peer | 2 | Research & Analysis |
| 7 | [Content Creation](#7-content-creation) | orchestrator | 3 | Content |
| 8 | [CLI Agent Team](#8-cli-agent-team) | orchestrator | 3 | Multi-Model |

---

## Development

### 1. Solo Developer

The simplest possible configuration — one peer agent with team tools.

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

**When to use:** Getting started, or when you just need one agent with shared memory, activity logging, and run tracking.

---

### 2. Co-Reviewer

Multi-perspective review team with complementary focuses. Inspired by the AI-Pair pattern — different reviewers catch different issues.

```json
{
  "teams": {
    "reviewers": {
      "description": "Multi-perspective code review team",
      "coordination": "peer",
      "members": {
        "correctness-reviewer": {
          "role": "Code reviewer focusing on correctness and reliability. Check logic errors, edge cases, error handling, null safety, race conditions, and off-by-one bugs. Verify that the code does what it claims to do.",
          "skills": ["review", "correctness", "testing", "edge-cases"]
        },
        "security-reviewer": {
          "role": "Code reviewer focusing on security and performance. Check for OWASP top 10 vulnerabilities, injection risks, auth/authz issues, data exposure, memory leaks, N+1 queries, and unnecessary allocations. Flag anything that could be exploited or cause degradation at scale.",
          "skills": ["review", "security", "performance", "vulnerabilities"]
        },
        "architecture-reviewer": {
          "role": "Code reviewer focusing on architecture and maintainability. Evaluate design patterns, coupling, cohesion, API surface, naming, abstraction levels, and consistency with existing codebase conventions. Suggest structural improvements.",
          "skills": ["review", "architecture", "design-patterns", "maintainability"]
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

**When to use:** Code review workflows where you want multiple expert perspectives. Each reviewer has distinct skills, so tasks route to the reviewer whose expertise best matches the review type.

**Tip:** For true model diversity (like AI-Pair), add `"cli": "codex"` or `"cli": "gemini"` to individual reviewers. See [CLI Agent Team](#8-cli-agent-team) for details.

---

### 3. Product Team

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
          "role": "Project manager. Break down goals into specific, implementable tasks. Assign each task to the team member whose skills best match. Review deliverables for quality and completeness. Request revisions if standards aren't met. You coordinate — never implement yourself."
        },
        "frontend": {
          "role": "Frontend developer. Expert in React, TypeScript, CSS, and UI/UX implementation. Build user interfaces, handle client-side state, implement responsive layouts. Deliver working code with component documentation.",
          "skills": ["frontend", "react", "typescript", "css", "ui"]
        },
        "backend": {
          "role": "Backend developer. Expert in Node.js, APIs, databases, and server architecture. Build endpoints, design data models, implement business logic and authentication. Deliver API implementations with schema definitions.",
          "skills": ["backend", "api", "database", "nodejs", "server"]
        },
        "qa": {
          "role": "QA engineer. Write unit, integration, and e2e tests. Validate implementations against requirements. Report bugs with clear reproduction steps and expected vs actual behavior. Deliver test files and a test coverage report.",
          "skills": ["testing", "qa", "validation", "e2e"]
        }
      },
      "workflow": {
        "timeout": 900
      }
    }
  }
}
```

**When to use:** Structured development where you want a PM to plan, delegate, and review. Skill-based routing automatically matches tasks to the right member.

---

### 4. Pipeline

Staged workflow with quality gates and automatic fail-loopback.

```json
{
  "teams": {
    "pipeline": {
      "description": "Staged pipeline: design → implement → review with quality gates",
      "coordination": "orchestrator",
      "orchestrator": "pm",
      "members": {
        "pm": {
          "role": "Pipeline manager. Start runs with clear goals. Monitor stage progress. Approve completed work only when deliverables and results meet quality standards."
        },
        "designer": {
          "role": "System designer. Create technical designs, API specifications, and architecture documents. Define interfaces, data flows, and component boundaries before implementation begins.",
          "skills": ["design", "architecture", "api-design"]
        },
        "developer": {
          "role": "Implementation developer. Write code strictly according to the design spec. Create tests alongside implementation. Attach code files as deliverables when marking tasks complete.",
          "skills": ["coding", "implementation", "testing"]
        },
        "reviewer": {
          "role": "Code reviewer. Review implementations for correctness, security, and adherence to design. If issues are found, fail the review with specific feedback — the system will automatically create a rework task.",
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

**When to use:** Structured development with stage gates. If review fails, work loops back to implementation automatically.

**How it works:**
1. `team_run(action: "start")` auto-generates 3 tasks: design → implement → review
2. Each stage is assigned via role matching
3. Later stages are BLOCKED until earlier ones complete
4. If review FAILS, a rework task is created at the implement stage and review is re-blocked
5. COMPLETED transitions require deliverables + result + orchestrator approval

---

## Research & Analysis

### 5. Research Team

Three peer agents for research-to-report workflows. Each handles a different phase — finding sources, analyzing data, and writing the final output.

```json
{
  "teams": {
    "research": {
      "description": "Research team: gather sources, analyze data, produce reports",
      "coordination": "peer",
      "members": {
        "researcher": {
          "role": "Research specialist. Find relevant sources, academic papers, documentation, and data. Evaluate source credibility and relevance. Store key findings in team_memory(store: docs) so the analyst can access them. Create structured research briefs with citations.",
          "skills": ["research", "sources", "literature-review", "data-gathering"]
        },
        "analyst": {
          "role": "Analysis specialist. Take raw research and data from team_memory, identify patterns, trends, and correlations. Produce actionable insights with confidence levels. Use team_task learnings to capture key findings for cross-run persistence.",
          "skills": ["analysis", "synthesis", "patterns", "insights"]
        },
        "writer": {
          "role": "Report writer. Transform research briefs and analysis into polished, reader-friendly reports. Structure content with executive summary, key findings, detailed analysis, and recommendations. Adapt tone to the target audience.",
          "skills": ["writing", "reports", "communication", "formatting"]
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

**When to use:** Research projects, literature reviews, market research, technical evaluations. The researcher gathers, the analyst synthesizes, the writer polishes.

**Tip:** Cross-run knowledge retention means the team builds institutional memory — previous research findings persist and inform future runs.

---

### 6. Competitive Analysis

Two peer agents with complementary analysis perspectives — business strategy and technical depth.

```json
{
  "teams": {
    "competitive": {
      "description": "Competitive analysis: market positioning + technical evaluation",
      "coordination": "peer",
      "members": {
        "market-analyst": {
          "role": "Market and business analyst. Analyze competitors' positioning, pricing models, target markets, go-to-market strategies, and brand perception. Produce SWOT analysis and strategic recommendations. Store findings in team_memory for cross-reference with technical analysis.",
          "skills": ["market-analysis", "strategy", "positioning", "business-model"]
        },
        "tech-analyst": {
          "role": "Technical analyst. Evaluate competitors' technology stacks, architecture choices, API design, performance characteristics, and developer experience. Compare feature sets and identify technical gaps or advantages. Coordinate with market-analyst via team_send to align business and technical perspectives.",
          "skills": ["tech-analysis", "architecture", "features", "developer-experience"]
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

**When to use:** Competitive intelligence, product strategy, due diligence. Market analyst covers the business angle, tech analyst covers the technical angle. Their findings converge into a complete competitive picture.

---

## Content

### 7. Content Creation

Editor-led content pipeline with drafting and fact-checking stages.

```json
{
  "teams": {
    "content": {
      "description": "Content pipeline: plan → draft → verify with editorial review",
      "coordination": "orchestrator",
      "orchestrator": "editor",
      "members": {
        "editor": {
          "role": "Content editor and project lead. Plan content structure and editorial brief. Assign writing tasks with clear briefs including target audience, tone, length, and key points. Review drafts for clarity, accuracy, style consistency, and audience fit. Request revisions with specific feedback if quality standards aren't met."
        },
        "writer": {
          "role": "Content writer. Draft articles, blog posts, documentation, or marketing copy based on editorial briefs. Adapt tone and style to the target audience. Structure content with clear headings, logical flow, and engaging opening/closing. Deliver drafts as deliverables.",
          "skills": ["writing", "drafting", "storytelling", "adaptation"]
        },
        "fact-checker": {
          "role": "Fact-checker and accuracy reviewer. Verify all claims, statistics, and references in content drafts. Check for potential bias, misleading framing, or outdated information. Produce a verification report with confidence ratings for each claim. Flag issues clearly so the writer can address them.",
          "skills": ["fact-checking", "verification", "accuracy", "sources"]
        }
      },
      "workflow": {
        "timeout": 900,
        "template": {
          "stages": [
            { "name": "draft", "role": "writer", "skills": ["writing"] },
            { "name": "verify", "role": "fact-checker", "skills": ["fact-checking"] }
          ],
          "fail_handlers": {
            "verify": "draft"
          }
        }
      }
    }
  }
}
```

**When to use:** Blog posts, documentation, marketing content, technical writing. The editor plans, the writer drafts, the fact-checker verifies. If verification fails, the draft loops back for revision.

---

## Multi-Model

### 8. CLI Agent Team

Mix native OpenClaw agents with external Claude, Codex, and Gemini CLI agents for model diversity.

```json
{
  "teams": {
    "hybrid": {
      "description": "Multi-model team: native orchestrator with CLI workers",
      "coordination": "orchestrator",
      "orchestrator": "lead",
      "members": {
        "lead": {
          "role": "Team lead and orchestrator. Coordinate work across CLI agents. Decompose goals into tasks, assign to the agent whose strengths match. Review results and request revisions if needed. You coordinate — the CLI agents implement."
        },
        "claude-dev": {
          "role": "Developer using Claude Code. Handle complex implementation tasks requiring deep reasoning, large refactors, and careful architectural decisions.",
          "skills": ["coding", "architecture", "refactoring", "complex-logic"],
          "cli": "claude",
          "cli_options": {
            "cwd": "./src",
            "thinking": true
          }
        },
        "codex-dev": {
          "role": "Developer using Codex. Handle rapid prototyping, scripting, and straightforward implementation tasks.",
          "skills": ["coding", "prototyping", "scripts", "automation"],
          "cli": "codex",
          "cli_options": {
            "cwd": "./src"
          }
        }
      }
    }
  }
}
```

**When to use:** Leveraging different AI models' strengths. Each CLI agent runs in its own process with its own working directory. The native orchestrator coordinates while CLI agents implement.

**Prerequisites:**
- CLI tools must be installed and in PATH (`which claude`, `which codex`, `which gemini`)
- `node-pty` package required (`npm install node-pty`)
- See `references/cli-agents.md` for detailed setup and per-CLI differences

**Notes:**
- CLI agents spawn on-demand when assigned tasks (not at plugin activation)
- Use `/team agents` to check CLI agent status
- Use `/team logs hybrid/claude-dev` to view agent logs

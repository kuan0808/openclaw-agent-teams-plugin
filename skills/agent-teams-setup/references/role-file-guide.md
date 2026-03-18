# Role File Guide

Load role descriptions from external markdown files instead of inline strings.

---

## What is `role_file`

`role_file` is an alternative to the inline `role` property on a member config. Instead of writing the role description directly in the JSON config, you point to a markdown file that contains the full role prompt.

```json
{
  "members": {
    "reviewer": {
      "role_file": "roles/code-reviewer.md"
    }
  }
}
```

The plugin reads the file contents at agent startup and injects it into the system prompt, replacing what the inline `role` string would have provided.

---

## Path Resolution

- **Relative paths** resolve from `~/.openclaw/`. For example, `"roles/researcher.md"` resolves to `~/.openclaw/roles/researcher.md`.
- **Absolute paths** are used as-is. For example, `"/home/user/prompts/dev.md"` reads from that exact location.

In the source code (`prompt-builder.ts`), the resolution logic is:

```ts
const OPENCLAW_HOME = path.join(process.env.HOME, ".openclaw");
const filePath = path.isAbsolute(memberConfig.role_file)
  ? memberConfig.role_file
  : path.resolve(OPENCLAW_HOME, memberConfig.role_file);
```

---

## When to Use

Use `role_file` instead of inline `role` when:

- The role description is long or complex (more than 2-3 sentences)
- The same role is shared across multiple teams or configs
- You want to version-control prompts in a Git repo separately from the plugin config
- You iterate on prompts frequently and want to edit markdown, not JSON

---

## Using Bundled Templates

This plugin includes role templates in the `references/roles/` directory. To use them:

1. Copy the templates you want into your OpenClaw home directory:
   ```bash
   cp <plugin-dir>/skills/agent-teams-setup/references/roles/*.md ~/.openclaw/roles/
   ```
2. Reference them in your team config:
   ```json
   { "role_file": "roles/code-reviewer.md" }
   ```
3. The plugin reads the file at agent startup and injects it into the system prompt automatically.

---

## Available Templates

| File | Description |
|------|-------------|
| `pm-orchestrator.md` | Project coordinator who decomposes goals, assigns tasks, and drives review cycles |
| `code-reviewer.md` | Multi-dimensional code review specialist (correctness, security, architecture, performance) |
| `frontend-dev.md` | Frontend developer focused on UI/UX, React, CSS, and client-side logic |
| `backend-dev.md` | Backend developer covering APIs, databases, Node.js, and server architecture |
| `qa-engineer.md` | QA engineer writing tests, validating requirements, and reporting bugs |
| `researcher.md` | Research specialist for literature review, source finding, and data gathering |
| `analyst.md` | Data synthesis and pattern identification specialist with confidence-rated insights |
| `content-writer.md` | Audience-aware content writer for articles, docs, and marketing copy |
| `content-editor.md` | Editorial planner and quality reviewer for content pipelines |
| `fact-checker.md` | Accuracy verification specialist with source validation and bias detection |
| `competitive-analyst.md` | Market positioning, SWOT analysis, and competitive intelligence specialist |

---

## Format Guide

Recommended structure for role files:

1. **Identity** -- one-line statement of who the agent is
2. **Responsibilities** -- bulleted list of what the agent does
3. **Approach** -- how the agent thinks and works (priorities, quality bars, methodology)
4. **Output Format** -- expected structure of deliverables (reports, code, reviews, etc.)
5. **Collaboration** -- how the agent uses team tools (`team_task`, `team_send`, `team_memory`, etc.)

See `roles/code-reviewer.md` for a complete example following this structure.

---

## Writing Your Own

Tips for effective role files:

- **Be specific about deliverable format.** "Produce a structured review report with severity levels" is better than "review the code."
- **Reference team tools.** Tell the agent when to use `team_task`, `team_send`, `team_memory`, and `team_inbox` so it collaborates effectively.
- **Define quality standards.** Specify what "done" looks like -- acceptance criteria, required artifacts, minimum coverage.
- **Explain escalation rules.** State when the agent should handle something independently vs. escalate to the orchestrator or another team member.
- **Keep it under 500 words.** Longer prompts dilute the key instructions. Be direct.

---

## Inline vs File Comparison

**Inline (short roles):**
```json
{
  "members": {
    "dev": {
      "role": "Backend developer. Builds APIs and handles server-side logic."
    }
  }
}
```

**File-based (detailed roles):**
```json
{
  "members": {
    "dev": {
      "role_file": "roles/backend-dev.md"
    }
  }
}
```

Where `~/.openclaw/roles/backend-dev.md` contains the full role prompt with identity, responsibilities, approach, output format, and collaboration instructions -- typically 20-40 lines of structured markdown.

---

## Fallback Behavior

If the file specified in `role_file` cannot be read (missing, permissions error, etc.), the plugin silently falls back to the inline `role` value. No error is thrown or logged.

This means you can set both as a safety net:
```json
{
  "role_file": "roles/backend-dev.md",
  "role": "Backend developer"
}
```

If the file is available, its contents are used. If not, the inline `"Backend developer"` string is used instead.

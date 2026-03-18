/**
 * Config validation for AgentTeamsConfig.
 */

import type {
  AgentTeamsConfig,
  CliOptions,
  CliType,
  GateConfig,
  KnowledgeConfig,
  TeamConfig,
  WorkflowStage,
  WorkflowTemplate,
} from "./types.js";

export interface ConfigValidationResult {
  ok: boolean;
  errors: string[];
}

const CORE_TEAM_TOOLS = [
  "team_run",
  "team_task",
  "team_memory",
  "team_send",
  "team_inbox",
];

function validateRequiredTools(
  errors: string[],
  teamName: string,
  memberKey: string,
  team: Record<string, unknown>,
  member: Record<string, unknown>,
): void {
  if (member.cli !== undefined) {
    return;
  }

  const tools = member.tools;
  if (!tools || typeof tools !== "object") {
    return;
  }

  const allow = Array.isArray((tools as Record<string, unknown>).allow)
    ? ((tools as Record<string, unknown>).allow as string[])
    : undefined;
  const deny = Array.isArray((tools as Record<string, unknown>).deny)
    ? ((tools as Record<string, unknown>).deny as string[])
    : undefined;

  if (allow) {
    for (const toolName of CORE_TEAM_TOOLS) {
      if (!allow.includes(toolName)) {
        errors.push(
          `Team "${teamName}", member "${memberKey}": tools.allow must include "${toolName}" for Agent Teams to work`,
        );
      }
    }
  }

  if (deny) {
    for (const toolName of CORE_TEAM_TOOLS) {
      if (deny.includes(toolName)) {
        errors.push(
          `Team "${teamName}", member "${memberKey}": tools.deny must not block "${toolName}"`,
        );
      }
    }
  }
}

export function validateConfig(raw: unknown): ConfigValidationResult {
  const errors: string[] = [];

  if (!raw || typeof raw !== "object") {
    return { ok: false, errors: ["Config must be an object"] };
  }

  const config = raw as Record<string, unknown>;

  if (!config.teams || typeof config.teams !== "object") {
    return { ok: false, errors: ["Config must have a 'teams' object"] };
  }

  const teams = config.teams as Record<string, unknown>;

  for (const [name, teamRaw] of Object.entries(teams)) {
    if (!teamRaw || typeof teamRaw !== "object") {
      errors.push(`Team "${name}": must be an object`);
      continue;
    }

    const team = teamRaw as Record<string, unknown>;

    if (!team.description || typeof team.description !== "string") {
      errors.push(`Team "${name}": missing or invalid 'description'`);
    }

    if (!team.coordination || !["orchestrator", "peer"].includes(team.coordination as string)) {
      errors.push(`Team "${name}": 'coordination' must be "orchestrator" or "peer"`);
    }

    if (team.coordination === "orchestrator" && !team.orchestrator) {
      errors.push(`Team "${name}": orchestrator mode requires an 'orchestrator' field`);
    }

    if (!team.members || typeof team.members !== "object") {
      errors.push(`Team "${name}": missing or invalid 'members' object`);
      continue;
    }

    const members = team.members as Record<string, unknown>;

    if (Object.keys(members).length === 0) {
      errors.push(`Team "${name}": must have at least one member`);
    }

    if (team.orchestrator && typeof team.orchestrator === "string") {
      if (!(team.orchestrator in members)) {
        errors.push(
          `Team "${name}": orchestrator "${team.orchestrator}" is not listed in members`,
        );
      }
    }

    for (const [memberKey, memberRaw] of Object.entries(members)) {
      if (!memberRaw || typeof memberRaw !== "object") {
        errors.push(`Team "${name}", member "${memberKey}": must be an object`);
        continue;
      }
      const member = memberRaw as Record<string, unknown>;
      if (!member.role && !member.role_file) {
        errors.push(
          `Team "${name}", member "${memberKey}": must have 'role' or 'role_file'`,
        );
      }
      if (member.cli !== undefined) {
        const validCli = ["claude", "codex", "gemini"];
        if (!validCli.includes(member.cli as string)) {
          errors.push(
            `Team "${name}", member "${memberKey}": 'cli' must be one of ${validCli.join(", ")}`,
          );
        }
      }
      if (member.cli_options !== undefined && typeof member.cli_options === "object") {
        const opts = member.cli_options as Record<string, unknown>;
        if (opts.cwd !== undefined && typeof opts.cwd !== "string") {
          errors.push(
            `Team "${name}", member "${memberKey}": 'cli_options.cwd' must be a string`,
          );
        }
        if (opts.extra_args !== undefined && !Array.isArray(opts.extra_args)) {
          errors.push(
            `Team "${name}", member "${memberKey}": 'cli_options.extra_args' must be an array`,
          );
        }
      }

      validateRequiredTools(errors, name, memberKey, team, member);
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Safely read a nested property from an untyped object. */
function prop(obj: unknown, key: string): unknown {
  if (obj && typeof obj === "object") return (obj as Record<string, unknown>)[key];
  return undefined;
}

/**
 * Parse raw plugin config into a typed AgentTeamsConfig.
 * Applies defaults for optional fields.
 */
export function parseConfig(raw: unknown): AgentTeamsConfig {
  const config = raw as Record<string, unknown>;
  const teams = config.teams as Record<string, unknown>;
  const result: AgentTeamsConfig = { teams: {} };

  for (const [name, teamRaw] of Object.entries(teams)) {
    const team = teamRaw as Record<string, unknown>;
    const workflow = team.workflow;
    const knowledge = team.knowledge;

    result.teams[name] = {
      description: team.description as string,
      coordination: team.coordination as TeamConfig["coordination"],
      orchestrator: team.orchestrator as string | undefined,
      shared_memory: parseSharedMemory(team.shared_memory),
      members: parseMembers(team.members as Record<string, unknown>),
      workflow: {
        max_rounds: (prop(workflow, "max_rounds") as number | undefined) ?? 10,
        timeout: (prop(workflow, "timeout") as number | undefined) ?? 900,
        gates: parseGates(prop(workflow, "gates")),
        template: parseWorkflowTemplate(prop(workflow, "template")),
      },
      knowledge: {
        consolidation: (prop(knowledge, "consolidation") as boolean | undefined) ?? true,
        retention: (prop(knowledge, "retention") as string | undefined as KnowledgeConfig["retention"]) ?? "across-runs",
        notify_leader: (prop(knowledge, "notify_leader") as boolean | undefined) ?? true,
      },
    };
  }

  return result;
}

function parseSharedMemory(raw: unknown): TeamConfig["shared_memory"] {
  if (!raw || typeof raw !== "object") {
    return { enabled: true, stores: {} };
  }
  const sm = raw as Record<string, unknown>;
  const stores = sm.stores;
  return {
    enabled: sm.enabled !== false,
    stores: {
      kv: (prop(stores, "kv") as Record<string, unknown> | undefined) ?? {},
      events: (prop(stores, "events") as Record<string, unknown> | undefined) ?? {},
      docs: (prop(stores, "docs") as Record<string, unknown> | undefined) ?? {},
    },
  };
}

function parseMembers(raw: Record<string, unknown>): TeamConfig["members"] {
  const members: TeamConfig["members"] = {};
  for (const [key, val] of Object.entries(raw)) {
    if (!val || typeof val !== "object") continue;
    const m = val as Record<string, unknown>;
    members[key] = {
      role: m.role as string | undefined,
      role_file: m.role_file as string | undefined,
      model: m.model as { primary: string } | undefined,
      skills: m.skills as string[] | undefined,
      tools: m.tools as { deny?: string[]; allow?: string[] } | undefined,
      cli: m.cli as CliType | undefined,
      cli_options: parseCliOptions(m.cli_options),
    };
  }
  return members;
}

function parseCliOptions(raw: unknown): CliOptions | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  return {
    cwd: o.cwd as string | undefined,
    thinking: o.thinking as boolean | undefined,
    verbose: o.verbose as boolean | undefined,
    extra_args: Array.isArray(o.extra_args) ? o.extra_args as string[] : undefined,
  };
}

function parseGates(raw: unknown): Record<string, GateConfig> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const gates: Record<string, GateConfig> = {};
  for (const [status, gateCfg] of Object.entries(raw as Record<string, unknown>)) {
    if (!gateCfg || typeof gateCfg !== "object") continue;
    const g = gateCfg as Record<string, unknown>;
    gates[status] = {
      require_deliverables: g.require_deliverables as boolean | undefined,
      require_result: g.require_result as boolean | undefined,
      approver: g.approver as string | undefined,
      reviewer: g.reviewer as string | undefined,
    };
  }
  return Object.keys(gates).length > 0 ? gates : undefined;
}

function parseWorkflowTemplate(raw: unknown): WorkflowTemplate | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const t = raw as Record<string, unknown>;
  if (!Array.isArray(t.stages)) return undefined;

  const stages: WorkflowStage[] = [];
  for (const stageRaw of t.stages) {
    if (!stageRaw || typeof stageRaw !== "object") continue;
    const s = stageRaw as Record<string, unknown>;
    if (!s.name || typeof s.name !== "string") continue;
    stages.push({
      name: s.name,
      role: s.role as string | undefined,
      skills: s.skills as string[] | undefined,
    });
  }

  if (stages.length === 0) return undefined;

  const fail_handlers = t.fail_handlers as Record<string, string> | undefined;

  return { stages, fail_handlers };
}

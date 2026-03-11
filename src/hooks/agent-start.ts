/**
 * before_agent_start hook — injects team context into agent prompt.
 *
 * When a team agent (at--*) starts, this hook prepends:
 *  - Role description
 *  - Team goal & run status
 *  - Team member directory
 *  - Available tools guide
 *  - Decision flow
 *  - Previous learnings
 *
 * Delegates to shared buildSystemPrompt() from prompt-builder for prompt construction.
 */

import { isTeamAgent, parseAgentId, isCliMember } from "../types.js";
import { getRegistry } from "../registry.js";
import { buildSystemPrompt } from "../cli/prompt-builder.js";

export function createAgentStartHook(): (
  event: { prompt: string; messages?: unknown[] },
  ctx: { agentId?: string; sessionKey?: string },
) => Promise<
  | { prependContext?: string; systemPrompt?: string; modelOverride?: string; providerOverride?: string }
  | void
> {
  return async (event, ctx) => {
    if (!isTeamAgent(ctx.agentId)) return;

    const parsed = parseAgentId(ctx.agentId!);
    if (!parsed) return;

    const { team, member } = parsed;
    const registry = getRegistry();

    const teamConfig = registry.getTeamConfig(team);
    if (!teamConfig) return;

    const memberConfig = teamConfig.members[member];
    if (!memberConfig) return;

    // CLI agents are not OpenClaw subagents — skip hook injection
    if (isCliMember(memberConfig)) return;

    const stores = registry.getTeamStores(team);
    if (!stores) return;

    const prependContext = await buildSystemPrompt({
      team,
      member,
      teamConfig,
      memberConfig,
      stores,
      isCli: false,
    });

    const modelOverride = memberConfig.model?.primary;

    return {
      prependContext,
      ...(modelOverride ? { modelOverride } : {}),
    };
  };
}

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
 * Supports per-run sessions: parses sessionKey to extract runId,
 * then builds run-specific prompt and registers the session.
 *
 * Delegates to shared buildSystemPrompt() from prompt-builder for prompt construction.
 */

import { isTeamAgent, parseAgentId, parseRunSessionKey, isCliMember } from "../types.js";
import { getRegistry, registerRunSession } from "../registry.js";
import { buildSystemPrompt } from "../cli/prompt-builder.js";
import { autoTransitionPendingToWorking } from "../tools/tool-helpers.js";

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

    // Parse sessionKey for per-run context
    let runId: string | undefined;
    if (ctx.sessionKey) {
      const parsedSession = parseRunSessionKey(ctx.sessionKey);
      if (parsedSession) {
        runId = parsedSession.runId;
        registerRunSession(registry, ctx.agentId!, runId, ctx.sessionKey, Date.now());
      } else {
        // Legacy spawn path — register in 1:1 maps
        registry.sessions.set(ctx.agentId!, ctx.sessionKey);
        registry.sessionToAgent.set(ctx.sessionKey, ctx.agentId!);
      }
    }

    const prependContext = await buildSystemPrompt({
      team,
      member,
      teamConfig,
      memberConfig,
      stores,
      isCli: false,
      runId,
    });

    // Auto-transition PENDING tasks to WORKING for this member (in this run)
    await autoTransitionPendingToWorking(team, member, stores, runId);

    const modelOverride = memberConfig.model?.primary;

    return {
      prependContext,
      ...(modelOverride ? { modelOverride } : {}),
    };
  };
}

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

import { isTeamAgent, parseAgentId, parseRunSessionKey, isCliMember, makeAgentId, makeRunSessionKey } from "../types.js";
import { getRegistry, registerRunSession } from "../registry.js";
import { buildSystemPrompt, buildMainAgentContext } from "../cli/prompt-builder.js";
import { autoTransitionPendingToWorking } from "../tools/tool-helpers.js";
import { ORCH_IDLE_GRACE_MS } from "../enforcement.js";
import { buildOrchReactivationMessage } from "../helpers/notification-helpers.js";

export function createAgentStartHook(): (
  event: { prompt: string; messages?: unknown[] },
  ctx: { agentId?: string; sessionKey?: string },
) => Promise<
  | { prependContext?: string; systemPrompt?: string; modelOverride?: string; providerOverride?: string }
  | void
> {
  return async (event, ctx) => {
    const registry = getRegistry();

    if (!isTeamAgent(ctx.agentId)) {
      const teamNames = Object.keys(registry.config.teams);
      if (teamNames.length === 0) return;

      let prependContext = buildMainAgentContext(registry.config);

      // Proactive idle orchestrator detection
      const now = Date.now();
      for (const [teamName, teamConfig] of Object.entries(registry.config.teams)) {
        if (teamConfig.coordination !== "orchestrator" || !teamConfig.orchestrator) continue;
        const orchMember = teamConfig.members[teamConfig.orchestrator];
        if (!orchMember || isCliMember(orchMember)) continue;
        const stores = registry.getTeamStores(teamName);
        if (!stores) continue;
        for (const run of stores.runs.getWorkingRuns()) {
          if (run.tasks.length > 0 || (now - run.started_at) <= ORCH_IDLE_GRACE_MS) continue;
          const orchAgentId = makeAgentId(teamName, teamConfig.orchestrator);
          const orchSessionKey = makeRunSessionKey(orchAgentId, run.id);
          const reactivation = buildOrchReactivationMessage(teamConfig, run.goal);
          prependContext +=
            `\n\n### IDLE ORCHESTRATOR — ${teamName}\n` +
            `Run "${run.id}" active for ${Math.round((now - run.started_at) / 1000)}s with ZERO tasks.\n` +
            `Re-activate: sessions_send({ message: ${JSON.stringify(reactivation)}, sessionKey: ${JSON.stringify(orchSessionKey)} })`;
        }
      }

      return { prependContext };
    }

    const parsed = parseAgentId(ctx.agentId!);
    if (!parsed) return;

    const { team, member } = parsed;

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

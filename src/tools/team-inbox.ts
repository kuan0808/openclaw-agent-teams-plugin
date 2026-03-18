/**
 * team_inbox — Read messages, event subscription, and activity log queries.
 *
 * Data sources:
 *  - inbox (default) — direct messages from other members
 *  - events — event queue pub/sub topics
 *  - activity — system activity log (task/run lifecycle, dependencies)
 */

import { Type, type Static } from "@sinclair/typebox";
import { textResult, errorResult, resolveToolContext, requireTeamAgent, type ToolContext } from "./tool-helpers.js";
import type { ActivityType } from "../types.js";

// ── Parameters ──────────────────────────────────────────────────────────

const Parameters = Type.Object({
  team: Type.Optional(
    Type.String({ description: "Team name (auto-resolved for at-- agents)" }),
  ),
  limit: Type.Optional(
    Type.Number({ description: "Maximum messages to return (default: 10)", default: 10 }),
  ),
  ack: Type.Optional(
    Type.Boolean({ description: "Mark messages as read after retrieval (default: true)", default: true }),
  ),
  topic: Type.Optional(
    Type.String({ description: "Read from this event queue topic instead of the direct message inbox" }),
  ),
  since: Type.Optional(
    Type.String({ description: "ISO timestamp — only return events after this time (event queue and activity)" }),
  ),
  source: Type.Optional(
    Type.Union([
      Type.Literal("inbox"),
      Type.Literal("events"),
      Type.Literal("activity"),
    ], { description: "Data source. Default: 'inbox' (or 'events' if topic is provided)" }),
  ),
  action: Type.Optional(
    Type.Union([
      Type.Literal("read"),
      Type.Literal("list_topics"),
    ], { description: "Action: 'read' (default) or 'list_topics' to discover event topics" }),
  ),
  filter_type: Type.Optional(
    Type.String({ description: "Filter by activity type (e.g. 'task_completed'). Only for source=activity." }),
  ),
  filter_agent: Type.Optional(
    Type.String({ description: "Filter by member name. Only for source=activity." }),
  ),
});

type Params = Static<typeof Parameters>;

// ── Helpers ──────────────────────────────────────────────────────────────

function parseSinceParam(since: string | undefined): { ok: true; value: number | undefined } | { ok: false; error: ReturnType<typeof errorResult> } {
  if (!since) return { ok: true, value: undefined };
  const parsed = Date.parse(since);
  if (isNaN(parsed)) return { ok: false, error: errorResult(`Invalid ISO timestamp: "${since}"`) };
  return { ok: true, value: parsed };
}

// ── Factory ─────────────────────────────────────────────────────────────

export function teamInboxTool(ctx: ToolContext) {
  return {
    name: "team_inbox",
    label: "Team Inbox",
    description:
      "Read team inbox messages or subscribe to event topics. Requires 'team' parameter for non-team agents. Sources: inbox, events (via topic), activity (system log).",
    parameters: Parameters,

    async execute(
      _toolCallId: string,
      params: Params,
      _signal?: AbortSignal,
    ) {
      // Main agent should delegate to team agents, not call team_inbox directly
      const guard = requireTeamAgent(ctx.agentId, "team_inbox");
      if (guard) return guard;

      const resolved = resolveToolContext(ctx.agentId, params.team);
      if (!resolved.ok) return resolved.error;
      const { teamCtx, stores } = resolved;

      const limit = params.limit ?? 10;
      const ack = params.ack ?? true;

      // ── Priority 1: list_topics action ──────────────────────────────
      if (params.action === "list_topics") {
        const topics = stores.events.getTopics();
        return textResult({
          team: teamCtx.team,
          count: topics.length,
          topics,
          hint: "Use team_inbox(topic: '<name>') to subscribe",
        });
      }

      // ── Priority 2: source=activity + topic conflict ────────────────
      if (params.source === "activity" && params.topic) {
        return errorResult("Cannot use 'topic' with source='activity'. Use filter_type/filter_agent instead.");
      }

      // ── Priority 3: activity source ─────────────────────────────────
      if (params.source === "activity") {
        const since = parseSinceParam(params.since);
        if (!since.ok) return since.error;

        const entries = stores.activity.query({
          type: params.filter_type as ActivityType | undefined,
          agent: params.filter_agent,
          since: since.value,
          limit,
        });

        return textResult({
          source: "activity",
          team: teamCtx.team,
          count: entries.length,
          entries: entries.map(e => ({
            id: e.id,
            type: e.type,
            agent: e.agent,
            description: e.description,
            target_id: e.target_id ?? null,
            metadata: e.metadata ?? null,
            timestamp: new Date(e.timestamp).toISOString(),
          })),
        });
      }

      // ── Priority 4: topic → implicit events source ──────────────────
      if (params.topic || params.source === "events") {
        const since = parseSinceParam(params.since);
        if (!since.ok) return since.error;

        const topicName = params.topic ?? "*";
        const events = stores.events.read(topicName, since.value, limit);

        return textResult({
          source: "event_queue",
          topic: topicName,
          team: teamCtx.team,
          count: events.length,
          events: events.map((e) => ({
            id: e.id,
            from: e.from,
            message: e.message,
            data: e.data ?? null,
            timestamp: new Date(e.timestamp).toISOString(),
          })),
        });
      }

      // ── Priority 5: default inbox ───────────────────────────────────
      const messages = stores.messages.read(teamCtx.member, limit, ack);

      if (ack && messages.length > 0) {
        await stores.messages.save();
      }

      return textResult({
        source: "inbox",
        member: teamCtx.member,
        team: teamCtx.team,
        count: messages.length,
        messages,
      });
    },
  };
}

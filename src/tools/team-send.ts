/**
 * team_send — Inter-member communication + Event Queue publishing.
 *
 * Sends direct messages to team members or publishes to event topics.
 */

import { Type, type Static } from "@sinclair/typebox";
import { getRegistry } from "../registry.js";
import { textResult, errorResult, resolveToolContext, safeSaveAll, type ToolContext } from "./tool-helpers.js";

// ── Parameters ──────────────────────────────────────────────────────────

const Parameters = Type.Object({
  team: Type.Optional(
    Type.String({ description: "Team name (auto-resolved for at-- agents)" }),
  ),
  to: Type.Optional(
    Type.String({
      description:
        'Target member name, or "all" for broadcast. Used for direct messaging.',
    }),
  ),
  message: Type.String({ description: "Message content" }),
  topic: Type.Optional(
    Type.String({
      description: "Publish to this event queue topic instead of (or in addition to) direct messaging",
    }),
  ),
  data: Type.Optional(
    Type.String({ description: "JSON data payload for event queue messages" }),
  ),
});

type Params = Static<typeof Parameters>;

// ── Factory ─────────────────────────────────────────────────────────────

export function teamSendTool(ctx: ToolContext) {
  return {
    name: "team_send",
    label: "Team Send",
    description:
      "Send messages to team members or publish events to the team event queue. Use 'to' for direct messages, 'topic' for event publishing, or both.",
    parameters: Parameters,

    async execute(
      _toolCallId: string,
      params: Params,
      _signal?: AbortSignal,
    ) {
      const resolved = resolveToolContext(ctx.agentId, params.team);
      if (!resolved.ok) return resolved.error;
      const { teamCtx, stores } = resolved;

      if (!params.to && !params.topic) {
        return errorResult(
          "At least one of 'to' (direct message) or 'topic' (event queue) must be provided.",
        );
      }

      const { activity } = stores;
      const savesNeeded: Array<Promise<void>> = [];

      const results: Record<string, unknown> = {
        from: teamCtx.member,
        team: teamCtx.team,
      };

      // ── Event Queue publishing ──────────────────────────────────────
      if (params.topic) {
        let eventData: unknown;
        let jsonParseWarning: string | undefined;
        if (params.data) {
          try {
            eventData = JSON.parse(params.data);
          } catch {
            eventData = params.data;
            jsonParseWarning = "Data parameter was not valid JSON and was stored as a plain string.";
          }
        }

        const eventId = stores.events.publish(
          params.topic,
          teamCtx.member,
          params.message,
          eventData,
        );
        savesNeeded.push(stores.events.save());

        results.event = {
          published: true,
          topic: params.topic,
          event_id: eventId,
          ...(jsonParseWarning ? { warning: jsonParseWarning } : {}),
        };

        activity.log(teamCtx.team, teamCtx.member, "message_sent",
          `Event published to topic "${params.topic}"`, {
            metadata: { topic: params.topic },
          });
      }

      // ── Direct messaging ────────────────────────────────────────────
      if (params.to) {
        const registry = getRegistry();
        const teamConfig = registry.getTeamConfig(teamCtx.team);
        const members = teamConfig ? Object.keys(teamConfig.members) : [];

        if (params.to === "all") {
          const recipients = members.filter((m) => m !== teamCtx.member);
          for (const recipient of recipients) {
            stores.messages.push(teamCtx.member, recipient, params.message);
          }
          savesNeeded.push(stores.messages.save());

          results.direct = {
            sent: true,
            broadcast: true,
            recipients,
            count: recipients.length,
          };
        } else {
          if (teamConfig && !teamConfig.members[params.to]) {
            return errorResult(
              `Member "${params.to}" not found in team "${teamCtx.team}". Available: ${members.join(", ")}`,
            );
          }

          stores.messages.push(teamCtx.member, params.to, params.message);
          savesNeeded.push(stores.messages.save());

          results.direct = {
            sent: true,
            to: params.to,
          };
        }

        const target = params.to === "all" ? "broadcast" : params.to;
        activity.log(teamCtx.team, teamCtx.member, "message_sent",
          `Message sent to ${target}: ${params.message.slice(0, 60)}`, {
            metadata: { to: params.to, has_topic: !!params.topic },
          });
      }

      savesNeeded.push(activity.save());
      await safeSaveAll(savesNeeded);

      return textResult(results);
    },
  };
}

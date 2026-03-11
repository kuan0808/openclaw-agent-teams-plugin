/**
 * team_memory — Shared memory (KV Store + Document Pool).
 *
 * Actions: get, set, delete, list
 */

import { Type, type Static } from "@sinclair/typebox";
import { textResult, errorResult, resolveToolContext, LEARNINGS_KEY_PREFIX, type ToolContext } from "./tool-helpers.js";
import type { TeamStores } from "../registry.js";
import type { ResolvedTeamContext } from "../context.js";

// ── Helpers ──────────────────────────────────────────────────────────────

function logMemoryUpdate(
  stores: TeamStores,
  teamCtx: ResolvedTeamContext,
  store: "kv" | "docs",
  action: "set" | "delete",
  key: string,
  extras?: Record<string, unknown>,
): void {
  stores.activity.log(teamCtx.team, teamCtx.member, "memory_updated",
    `Memory ${action}: ${store}/${key}`, {
      metadata: { store, action, key, ...extras },
    });
}

// ── Parameters ──────────────────────────────────────────────────────────

const Parameters = Type.Object({
  action: Type.Union(
    [
      Type.Literal("get"),
      Type.Literal("set"),
      Type.Literal("delete"),
      Type.Literal("list"),
    ],
    { description: "Memory action" },
  ),
  team: Type.Optional(
    Type.String({ description: "Team name (auto-resolved for at-- agents)" }),
  ),
  store: Type.Optional(
    Type.Union(
      [Type.Literal("kv"), Type.Literal("docs")],
      { description: "Target store: 'kv' (key-value) or 'docs' (document pool). Default: kv", default: "kv" },
    ),
  ),
  key: Type.Optional(
    Type.String({ description: "Key name (required for get/set/delete)" }),
  ),
  value: Type.Optional(
    Type.String({
      description:
        "Value to store. For KV: JSON-stringified value. For docs: raw content string.",
    }),
  ),
  ttl: Type.Optional(
    Type.Number({ description: "Time-to-live in seconds (KV store only)" }),
  ),
  content_type: Type.Optional(
    Type.String({
      description: 'Content type for docs (e.g. "text/markdown", "application/json")',
    }),
  ),
});

type Params = Static<typeof Parameters>;

// ── Factory ─────────────────────────────────────────────────────────────

export function teamMemoryTool(ctx: ToolContext) {
  return {
    name: "team_memory",
    label: "Team Memory",
    description:
      "Read and write shared team memory. Supports key-value store (ephemeral data, counters, flags) and document pool (larger content, markdown, data files).",
    parameters: Parameters,

    async execute(
      _toolCallId: string,
      params: Params,
      _signal?: AbortSignal,
    ) {
      const resolved = resolveToolContext(ctx.agentId, params.team);
      if (!resolved.ok) return resolved.error;
      const { teamCtx, stores } = resolved;

      const storeName = params.store ?? "kv";

      // ── KV Store ──────────────────────────────────────────────────
      if (storeName === "kv") {
        const { kv } = stores;

        switch (params.action) {
          case "get": {
            if (!params.key) {
              return errorResult("Parameter 'key' is required for action=get.");
            }
            const result = kv.get(params.key);
            if (!result.found) {
              return textResult({ found: false, key: params.key });
            }
            return textResult({
              found: true,
              key: params.key,
              value: result.value,
              written_by: result.written_by,
              ttl_remaining: result.ttl_remaining ?? null,
            });
          }

          case "set": {
            if (!params.key) {
              return errorResult("Parameter 'key' is required for action=set.");
            }
            if (params.value === undefined) {
              return errorResult("Parameter 'value' is required for action=set.");
            }

            // Parse JSON value
            let parsedValue: unknown;
            try {
              parsedValue = JSON.parse(params.value);
            } catch {
              // If not valid JSON, store as plain string
              parsedValue = params.value;
            }

            const result = kv.set(params.key, parsedValue, teamCtx.member, params.ttl);
            logMemoryUpdate(stores, teamCtx, "kv", "set", params.key);
            await Promise.all([kv.save(), stores.activity.save()]);

            return textResult({
              ok: true,
              key: params.key,
              replaced: result.replaced,
              written_by: teamCtx.member,
              ttl: params.ttl ?? null,
            });
          }

          case "delete": {
            if (!params.key) {
              return errorResult("Parameter 'key' is required for action=delete.");
            }
            const deleted = kv.delete(params.key);
            logMemoryUpdate(stores, teamCtx, "kv", "delete", params.key, { deleted });
            await Promise.all([kv.save(), stores.activity.save()]);

            return textResult({
              ok: true,
              key: params.key,
              deleted,
            });
          }

          case "list": {
            const entries = kv.list();
            const userEntries = entries.filter(e => !e.key.startsWith(LEARNINGS_KEY_PREFIX));
            return textResult({
              store: "kv",
              team: teamCtx.team,
              count: userEntries.length,
              entries: userEntries,
            });
          }

          default:
            return errorResult(`Unknown action: ${params.action}`);
        }
      }

      // ── Doc Pool ──────────────────────────────────────────────────
      if (storeName === "docs") {
        const { docs } = stores;

        switch (params.action) {
          case "get": {
            if (!params.key) {
              return errorResult("Parameter 'key' is required for action=get.");
            }
            const result = await docs.get(params.key);
            if (!result.found) {
              return textResult({ found: false, key: params.key });
            }
            return textResult({
              found: true,
              key: params.key,
              content: result.value,
              content_type: result.content_type,
              written_by: result.written_by,
            });
          }

          case "set": {
            if (!params.key) {
              return errorResult("Parameter 'key' is required for action=set.");
            }
            if (params.value === undefined) {
              return errorResult("Parameter 'value' is required for action=set (raw content string).");
            }

            const contentType = params.content_type ?? "text/plain";
            const result = await docs.set(params.key, params.value, contentType, teamCtx.member);
            logMemoryUpdate(stores, teamCtx, "docs", "set", params.key, { content_type: contentType });
            await Promise.all([docs.save(), stores.activity.save()]);

            return textResult({
              ok: true,
              key: params.key,
              content_type: contentType,
              size_bytes: result.size_bytes,
              written_by: teamCtx.member,
            });
          }

          case "delete": {
            if (!params.key) {
              return errorResult("Parameter 'key' is required for action=delete.");
            }
            const deleted = await docs.delete(params.key);
            logMemoryUpdate(stores, teamCtx, "docs", "delete", params.key, { deleted });
            await Promise.all([docs.save(), stores.activity.save()]);

            return textResult({
              ok: true,
              key: params.key,
              deleted,
            });
          }

          case "list": {
            const entries = docs.list();
            return textResult({
              store: "docs",
              team: teamCtx.team,
              count: entries.length,
              entries,
            });
          }

          default:
            return errorResult(`Unknown action: ${params.action}`);
        }
      }

      return errorResult(`Unknown store: ${storeName}. Use "kv" or "docs".`);
    },
  };
}

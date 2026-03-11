/**
 * Tests for EventQueue repositioning + information flow optimization (v2).
 *
 * Covers: team_inbox (activity/list_topics), team_memory (audit + learnings filter),
 * team_command (stop audit), compaction hook (learnings filter), agent-start hook (topics).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { KvStore } from "../src/state/kv-store.js";
import { EventQueue } from "../src/state/event-queue.js";
import { DocPool } from "../src/state/doc-pool.js";
import { RunManager } from "../src/state/run-manager.js";
import { MessageStore } from "../src/state/message-store.js";
import { ActivityLog } from "../src/state/activity-log.js";
import { setRegistry, type TeamStores, type PluginRegistry } from "../src/registry.js";
import { teamInboxTool } from "../src/tools/team-inbox.js";
import { teamMemoryTool } from "../src/tools/team-memory.js";
import type { ToolContext } from "../src/tools/tool-helpers.js";
import { LEARNINGS_KEY_PREFIX } from "../src/tools/tool-helpers.js";

const tmpDir = path.join(os.tmpdir(), "at-test-v2-" + Math.random().toString(36).slice(2));

// ── Shared setup ────────────────────────────────────────────────────────

let stores: TeamStores;

async function initStores(): Promise<TeamStores> {
  const base = path.join(tmpDir, "team-dev");
  await fs.mkdir(base, { recursive: true });

  const kv = new KvStore(path.join(base, "kv.json"));
  const events = new EventQueue(path.join(base, "events.json"));
  const docs = new DocPool(path.join(base, "docs"));
  const runs = new RunManager(path.join(base, "runs"));
  const messages = new MessageStore(path.join(base, "messages.json"));
  const activity = new ActivityLog(path.join(base, "activity"));

  await Promise.all([kv.load(), events.load(), docs.load(), runs.load(), messages.load(), activity.load()]);

  return { kv, events, docs, runs, messages, activity };
}

function setupRegistry(st: TeamStores): void {
  const reg: PluginRegistry = {
    config: {
      teams: {
        dev: {
          description: "Dev team",
          coordination: "orchestrator",
          orchestrator: "lead",
          members: {
            lead: { role: "Lead" },
            alice: { role: "Developer", skills: ["coding"] },
          },
        },
      },
    },
    teams: new Map([["dev", st]]),
    sessions: new Map([["at--dev--alice", "session-1"]]),
    getTeamStores: (team: string) => (team === "dev" ? st : undefined),
    getTeamConfig: (team: string) => (team === "dev" ? reg.config.teams.dev : undefined),
    enqueueSystemEvent: () => true,
    requestHeartbeatNow: () => {},
  };
  setRegistry(reg);
}

function makeToolCtx(member = "alice"): ToolContext {
  return { agentId: `at--dev--${member}` };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("team_inbox: activity source", () => {
  beforeEach(async () => {
    stores = await initStores();
    setupRegistry(stores);

    // Seed activity log
    stores.activity.log("dev", "alice", "task_created", "Created task-1", { target_id: "task-1" });
    stores.activity.log("dev", "bob", "task_completed", "Completed task-2", { target_id: "task-2" });
    stores.activity.log("dev", "alice", "run_started", "Run started");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should return activity entries with correct format", async () => {
    const tool = teamInboxTool(makeToolCtx());
    const result = await tool.execute("call-1", { source: "activity" } as any);
    const data = (result as any).details;

    expect(data.source).toBe("activity");
    expect(data.team).toBe("dev");
    expect(data.count).toBe(3);
    expect(data.entries).toHaveLength(3);

    const first = data.entries[0];
    expect(first.id).toBe("act-0");
    expect(first.type).toBe("task_created");
    expect(first.agent).toBe("alice");
    expect(first.description).toBe("Created task-1");
    expect(first.target_id).toBe("task-1");
    expect(first.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO format
  });

  it("should filter by filter_type", async () => {
    const tool = teamInboxTool(makeToolCtx());
    const result = await tool.execute("call-1", {
      source: "activity",
      filter_type: "task_completed",
    } as any);
    const data = (result as any).details;

    expect(data.count).toBe(1);
    expect(data.entries[0].type).toBe("task_completed");
    expect(data.entries[0].agent).toBe("bob");
  });

  it("should filter by filter_agent", async () => {
    const tool = teamInboxTool(makeToolCtx());
    const result = await tool.execute("call-1", {
      source: "activity",
      filter_agent: "alice",
    } as any);
    const data = (result as any).details;

    expect(data.count).toBe(2);
    expect(data.entries.every((e: any) => e.agent === "alice")).toBe(true);
  });

  it("should error when source=activity and topic are both provided", async () => {
    const tool = teamInboxTool(makeToolCtx());
    const result = await tool.execute("call-1", {
      source: "activity",
      topic: "some-topic",
    } as any);
    const data = (result as any).details;

    expect(data.error).toContain("Cannot use 'topic' with source='activity'");
  });
});

describe("team_inbox: list_topics action", () => {
  beforeEach(async () => {
    stores = await initStores();
    setupRegistry(stores);

    // Seed event queue
    stores.events.publish("build", "alice", "Build started");
    stores.events.publish("deploy", "bob", "Deploy triggered");
    stores.events.publish("build", "alice", "Build done");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should return event queue topics", async () => {
    const tool = teamInboxTool(makeToolCtx());
    const result = await tool.execute("call-1", { action: "list_topics" } as any);
    const data = (result as any).details;

    expect(data.count).toBe(2);
    expect(data.topics).toEqual(["build", "deploy"]);
    expect(data.hint).toContain("team_inbox");
  });
});

describe("team_inbox: backward compatibility", () => {
  beforeEach(async () => {
    stores = await initStores();
    setupRegistry(stores);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should default to inbox when no new params provided", async () => {
    // Send a message to alice
    stores.messages.push("bob", "alice", "Hello");

    const tool = teamInboxTool(makeToolCtx());
    const result = await tool.execute("call-1", {} as any);
    const data = (result as any).details;

    expect(data.source).toBe("inbox");
    expect(data.member).toBe("alice");
  });

  it("should use events source when topic is provided without source", async () => {
    stores.events.publish("updates", "bob", "New update");

    const tool = teamInboxTool(makeToolCtx());
    const result = await tool.execute("call-1", { topic: "updates" } as any);
    const data = (result as any).details;

    expect(data.source).toBe("event_queue");
    expect(data.topic).toBe("updates");
    expect(data.count).toBe(1);
  });
});

describe("team_memory: ActivityLog audit", () => {
  beforeEach(async () => {
    stores = await initStores();
    setupRegistry(stores);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should log memory_updated for KV set", async () => {
    const tool = teamMemoryTool(makeToolCtx());
    await tool.execute("call-1", {
      action: "set",
      key: "foo",
      value: '"bar"',
    } as any);

    const entries = stores.activity.query({ type: "memory_updated" });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.description).toBe("Memory set: kv/foo");
    expect(entries[0]!.agent).toBe("alice");
    expect(entries[0]!.metadata).toEqual({ store: "kv", action: "set", key: "foo" });
  });

  it("should log memory_updated for KV delete", async () => {
    // First set, then delete
    stores.kv.set("mykey", "val", "alice");
    await stores.kv.save();

    const tool = teamMemoryTool(makeToolCtx());
    await tool.execute("call-1", {
      action: "delete",
      key: "mykey",
    } as any);

    const entries = stores.activity.query({ type: "memory_updated" });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.description).toBe("Memory delete: kv/mykey");
    expect(entries[0]!.metadata).toMatchObject({ store: "kv", action: "delete", key: "mykey", deleted: true });
  });

  it("should log memory_updated for DocPool set", async () => {
    const tool = teamMemoryTool(makeToolCtx());
    await tool.execute("call-1", {
      action: "set",
      store: "docs",
      key: "report",
      value: "# Report content",
      content_type: "text/markdown",
    } as any);

    const entries = stores.activity.query({ type: "memory_updated" });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.description).toBe("Memory set: docs/report");
    expect(entries[0]!.metadata).toEqual({
      store: "docs",
      action: "set",
      key: "report",
      content_type: "text/markdown",
    });
  });

  it("should log memory_updated for DocPool delete", async () => {
    // First set a doc
    await stores.docs.set("mydoc", "content", "text/plain", "alice");
    await stores.docs.save();

    const tool = teamMemoryTool(makeToolCtx());
    await tool.execute("call-1", {
      action: "delete",
      store: "docs",
      key: "mydoc",
    } as any);

    const entries = stores.activity.query({ type: "memory_updated" });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.description).toBe("Memory delete: docs/mydoc");
    expect(entries[0]!.metadata).toMatchObject({ store: "docs", action: "delete", key: "mydoc", deleted: true });
  });
});

describe("team_memory: learnings filter", () => {
  beforeEach(async () => {
    stores = await initStores();
    setupRegistry(stores);

    // Seed KV with user entries and learnings
    stores.kv.set("config:timeout", 30, "alice");
    stores.kv.set("config:retries", 3, "alice");
    stores.kv.set(`${LEARNINGS_KEY_PREFIX}failure:api-timeout`, {
      content: "API timeouts need retry",
      confidence: 0.9,
      category: "failure",
      timestamp: Date.now(),
    }, "system");
    stores.kv.set(`${LEARNINGS_KEY_PREFIX}pattern:auth`, {
      content: "Use JWT",
      confidence: 0.7,
      category: "pattern",
      timestamp: Date.now(),
    }, "system");
    await stores.kv.save();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should exclude learnings:* keys from KV list", async () => {
    const tool = teamMemoryTool(makeToolCtx());
    const result = await tool.execute("call-1", { action: "list" } as any);
    const data = (result as any).details;

    expect(data.count).toBe(2);
    expect(data.entries.every((e: any) => !e.key.startsWith(LEARNINGS_KEY_PREFIX))).toBe(true);
    expect(data.entries.map((e: any) => e.key).sort()).toEqual(["config:retries", "config:timeout"]);
  });

  it("should return empty list when only learnings keys exist", async () => {
    // Delete user entries
    stores.kv.delete("config:timeout");
    stores.kv.delete("config:retries");
    await stores.kv.save();

    const tool = teamMemoryTool(makeToolCtx());
    const result = await tool.execute("call-1", { action: "list" } as any);
    const data = (result as any).details;

    expect(data.count).toBe(0);
    expect(data.entries).toEqual([]);
  });
});

describe("team_command: handleStop audit", () => {
  beforeEach(async () => {
    stores = await initStores();
    setupRegistry(stores);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should log run_canceled to ActivityLog on stop", async () => {
    // Start a run first
    stores.runs.startRun("dev", "Test goal");
    await stores.runs.save();

    // Import and execute the command
    const { createTeamCommands } = await import("../src/commands/team-command.js");
    const commands = createTeamCommands();
    const stopCmd = commands.find(c => c.name === "team stop")!;

    await stopCmd.handler({
      args: "dev",
      config: {},
      senderId: "user",
      isAuthorizedSender: true,
    });

    const entries = stores.activity.query({ type: "run_canceled" });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.agent).toBe("__command__");
    expect(entries[0]!.description).toBe("Run stopped by user command");
    expect(entries[0]!.metadata).toMatchObject({
      reason: "Stopped by user command",
    });
  });

  it("should save ActivityLog after stop", async () => {
    stores.runs.startRun("dev", "Test goal");
    await stores.runs.save();

    const saveSpy = vi.spyOn(stores.activity, "save");

    const { createTeamCommands } = await import("../src/commands/team-command.js");
    const commands = createTeamCommands();
    const stopCmd = commands.find(c => c.name === "team stop")!;

    await stopCmd.handler({
      args: "dev",
      config: {},
      senderId: "user",
      isAuthorizedSender: true,
    });

    expect(saveSpy).toHaveBeenCalled();
    saveSpy.mockRestore();
  });
});

describe("compaction hook: learnings filter", () => {
  beforeEach(async () => {
    stores = await initStores();
    setupRegistry(stores);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should not include learnings:* keys in compaction summary", async () => {
    // Seed KV with user entries and learnings
    stores.kv.set("user:setting", "dark-mode", "alice");
    stores.kv.set(`${LEARNINGS_KEY_PREFIX}failure:timeout`, {
      content: "Timeout fix",
      confidence: 0.9,
      category: "failure",
      timestamp: Date.now(),
    }, "system");
    await stores.kv.save();

    // Start a run so there's context
    stores.runs.startRun("dev", "Test compaction");
    await stores.runs.save();

    const { createCompactionHook } = await import("../src/hooks/compaction.js");
    const hook = createCompactionHook();

    // Capture the enqueued system event text
    let enqueuedText = "";
    const reg = {
      config: { teams: { dev: { description: "Dev", coordination: "orchestrator" as const, members: { alice: { role: "Dev" } } } } },
      teams: new Map([["dev", stores]]),
      sessions: new Map([["at--dev--alice", "session-1"]]),
      getTeamStores: (team: string) => (team === "dev" ? stores : undefined),
      getTeamConfig: (team: string) => (team === "dev" ? reg.config.teams.dev : undefined),
      enqueueSystemEvent: (text: string) => { enqueuedText = text; return true; },
      requestHeartbeatNow: () => {},
    };
    setRegistry(reg);

    await hook(
      { messageCount: 100, compactingCount: 50, tokenCount: 8000 },
      { agentId: "at--dev--alice", sessionKey: "session-1" },
    );

    // Should contain user setting but NOT learnings
    expect(enqueuedText).toContain("user:setting");
    expect(enqueuedText).not.toContain("learnings:");
    expect(enqueuedText).not.toContain("Timeout fix");
  });
});

describe("agent-start hook: event topics awareness", () => {
  beforeEach(async () => {
    stores = await initStores();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should include Event Topics section when topics exist", async () => {
    stores.events.publish("build", "alice", "Build started");
    stores.events.publish("deploy", "bob", "Deploy triggered");

    const reg: PluginRegistry = {
      config: {
        teams: {
          dev: {
            description: "Dev",
            coordination: "orchestrator",
            orchestrator: "lead",
            members: {
              alice: { role: "Developer" },
              lead: { role: "Lead" },
            },
          },
        },
      },
      teams: new Map([["dev", stores]]),
      sessions: new Map(),
      getTeamStores: (team: string) => (team === "dev" ? stores : undefined),
      getTeamConfig: (team: string) => (team === "dev" ? reg.config.teams.dev : undefined),
      enqueueSystemEvent: () => true,
      requestHeartbeatNow: () => {},
    };
    setRegistry(reg);

    const { createAgentStartHook } = await import("../src/hooks/agent-start.js");
    const hook = createAgentStartHook();
    const result = await hook(
      { prompt: "do stuff" },
      { agentId: "at--dev--alice" },
    );

    expect(result).toBeDefined();
    const ctx = (result as any).prependContext as string;
    expect(ctx).toContain("## Event Topics");
    expect(ctx).toContain("build");
    expect(ctx).toContain("deploy");
    expect(ctx).toContain('source: "activity"');
  });

  it("should not include Event Topics section when no topics exist (but still show activity hint)", async () => {
    const reg: PluginRegistry = {
      config: {
        teams: {
          dev: {
            description: "Dev",
            coordination: "orchestrator",
            orchestrator: "lead",
            members: {
              alice: { role: "Developer" },
              lead: { role: "Lead" },
            },
          },
        },
      },
      teams: new Map([["dev", stores]]),
      sessions: new Map(),
      getTeamStores: (team: string) => (team === "dev" ? stores : undefined),
      getTeamConfig: (team: string) => (team === "dev" ? reg.config.teams.dev : undefined),
      enqueueSystemEvent: () => true,
      requestHeartbeatNow: () => {},
    };
    setRegistry(reg);

    const { createAgentStartHook } = await import("../src/hooks/agent-start.js");
    const hook = createAgentStartHook();
    const result = await hook(
      { prompt: "do stuff" },
      { agentId: "at--dev--alice" },
    );

    expect(result).toBeDefined();
    const ctx = (result as any).prependContext as string;
    expect(ctx).not.toContain("## Event Topics");
    expect(ctx).toContain('source: "activity"');
  });
});

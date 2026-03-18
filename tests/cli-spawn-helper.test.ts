import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

// Mock the prompt builder before importing spawnCliIfNeeded
vi.mock("../src/cli/prompt-builder.js", () => ({
  buildSystemPrompt: vi.fn(async () => "You are a test agent."),
}));

import { spawnCliIfNeeded } from "../src/tools/cli-spawn-helper.js";
import type { PluginRegistry, TeamStores } from "../src/registry.js";
import type { TeamConfig } from "../src/types.js";

const tmpDir = path.join(os.tmpdir(), "at-test-cli-helper-" + Math.random().toString(36).slice(2));

describe("spawnCliIfNeeded", () => {
  let mockRegistry: PluginRegistry;
  let mockStores: TeamStores;
  let mockSpawn: ReturnType<typeof vi.fn>;

  const teamConfig: TeamConfig = {
    description: "Test team",
    coordination: "orchestrator",
    orchestrator: "lead",
    members: {
      lead: {
        role: "Team lead",
      },
      frontend: {
        role: "Frontend developer",
        cli: "claude",
        cli_options: { cwd: "/tmp" },
      },
      backend: {
        role: "Backend developer",
        // No cli field — native agent
      },
    },
  };

  beforeEach(async () => {
    await fs.mkdir(tmpDir, { recursive: true });

    mockSpawn = vi.fn(async () => ({
      agentId: "at--dev--frontend",
      team: "dev",
      member: "frontend",
      cli: "claude",
      pid: 99999,
      status: "starting",
    }));

    mockStores = {
      activity: {
        log: vi.fn(),
        save: vi.fn(async () => {}),
      },
    } as unknown as TeamStores;

    mockRegistry = {
      cliSpawner: {
        isAlive: vi.fn(() => false),
        spawn: mockSpawn,
        kill: vi.fn(),
        killAll: vi.fn(async () => {}),
        getProcess: vi.fn(),
        getAllProcesses: vi.fn(() => new Map()),
        getLogPath: vi.fn(),
      },
    } as unknown as PluginRegistry;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("skips non-CLI members", async () => {
    await spawnCliIfNeeded(
      mockRegistry, "dev", "backend", teamConfig, mockStores, "Build API",
    );

    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("skips members not in config", async () => {
    await spawnCliIfNeeded(
      mockRegistry, "dev", "nonexistent", teamConfig, mockStores, "Do something",
    );

    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("skips already-alive agents", async () => {
    (mockRegistry.cliSpawner!.isAlive as ReturnType<typeof vi.fn>).mockReturnValue(true);

    await spawnCliIfNeeded(
      mockRegistry, "dev", "frontend", teamConfig, mockStores, "Build UI",
    );

    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("spawns CLI agent for CLI-configured member", async () => {
    await spawnCliIfNeeded(
      mockRegistry, "dev", "frontend", teamConfig, mockStores, "Build login page",
    );

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const spawnArgs = mockSpawn.mock.calls[0][0];
    expect(spawnArgs.agentId).toBe("at--dev--frontend");
    expect(spawnArgs.team).toBe("dev");
    expect(spawnArgs.member).toBe("frontend");
    expect(spawnArgs.cli).toBe("claude");
    expect(spawnArgs.initialTask).toBe("Build login page");
  });

  it("does nothing when no cliSpawner in registry", async () => {
    const registryWithoutSpawner = {
      ...mockRegistry,
      cliSpawner: undefined,
    } as unknown as PluginRegistry;

    await spawnCliIfNeeded(
      registryWithoutSpawner, "dev", "frontend", teamConfig, mockStores, "Build UI",
    );

    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("logs activity on spawn failure without throwing", async () => {
    mockSpawn.mockRejectedValue(new Error("PTY not available"));

    // Should NOT throw
    await spawnCliIfNeeded(
      mockRegistry, "dev", "frontend", teamConfig, mockStores, "Build UI",
    );

    expect(mockStores.activity.log).toHaveBeenCalled();
    expect(mockStores.activity.save).toHaveBeenCalled();
  });
});

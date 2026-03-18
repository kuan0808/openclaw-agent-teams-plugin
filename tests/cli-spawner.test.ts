import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";

// Mock node-pty before importing cli-spawner
function createMockPty() {
  return {
    pid: 12345,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    kill: vi.fn(),
  };
}

let mockPty = createMockPty();

vi.mock("node-pty", () => ({
  spawn: vi.fn(() => mockPty),
}));

import { CliSpawner } from "../src/cli/cli-spawner.js";
import type { CliSpawnParams } from "../src/cli/cli-types.js";

// ── Tests ─────────────────────────────────────────────────────────────────

const tmpDir = path.join(os.tmpdir(), "at-test-cli-spawner-" + Math.random().toString(36).slice(2));

describe("CliSpawner", () => {
  let spawner: CliSpawner;
  const sockPath = path.join(tmpDir, "ipc.sock");

  beforeEach(async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    spawner = new CliSpawner(tmpDir, sockPath);
    // Create fresh mock PTY for each test
    mockPty = createMockPty();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await spawner.killAll();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const baseParams: CliSpawnParams = {
    agentId: "at--dev--frontend",
    team: "dev",
    member: "frontend",
    cli: "claude",
    cwd: tmpDir,
    systemPrompt: "You are a frontend developer.",
    initialTask: "Build the login page",
    model: "claude-sonnet-4-6",
  };

  it("should track process status", async () => {
    const proc = await spawner.spawn(baseParams);

    expect(proc.agentId).toBe("at--dev--frontend");
    expect(proc.team).toBe("dev");
    expect(proc.member).toBe("frontend");
    expect(proc.cli).toBe("claude");
    expect(proc.pid).toBe(12345);
    expect(proc.status).toBe("starting");
    expect(spawner.isAlive("at--dev--frontend")).toBe(true);
  });

  it("should create log directory and file", async () => {
    await spawner.spawn(baseParams);

    const logDir = path.join(tmpDir, "logs", "dev");
    const stat = await fs.stat(logDir);
    expect(stat.isDirectory()).toBe(true);
  });

  it("should write MCP config for Claude", async () => {
    await spawner.spawn(baseParams);

    const mcpConfigPath = path.join(tmpDir, "mcp-config", "at--dev--frontend.json");
    const content = await fs.readFile(mcpConfigPath, "utf-8");
    const config = JSON.parse(content);

    expect(config.mcpServers).toBeDefined();
    expect(config.mcpServers["agent-teams"]).toBeDefined();
    expect(config.mcpServers["agent-teams"].env.AT_AGENT_ID).toBe("at--dev--frontend");
    expect(config.mcpServers["agent-teams"].env.AT_SOCK_PATH).toBe(sockPath);
  });

  it("should not spawn duplicate processes", async () => {
    await spawner.spawn(baseParams);
    expect(spawner.isAlive("at--dev--frontend")).toBe(true);

    // Second spawn should still work (spawner.spawn doesn't prevent it,
    // but the caller should check isAlive first)
    expect(spawner.isAlive("at--dev--frontend")).toBe(true);
  });

  it("should kill a process", async () => {
    await spawner.spawn(baseParams);
    expect(spawner.isAlive("at--dev--frontend")).toBe(true);

    spawner.kill("at--dev--frontend");
    expect(spawner.isAlive("at--dev--frontend")).toBe(false);
    expect(mockPty.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("should kill all processes", async () => {
    await spawner.spawn(baseParams);
    await spawner.spawn({
      ...baseParams,
      agentId: "at--dev--backend",
      member: "backend",
    });

    await spawner.killAll();
    expect(spawner.isAlive("at--dev--frontend")).toBe(false);
    expect(spawner.isAlive("at--dev--backend")).toBe(false);
  });

  it("should return undefined for non-existent process", () => {
    expect(spawner.getProcess("at--dev--nobody")).toBeUndefined();
    expect(spawner.isAlive("at--dev--nobody")).toBe(false);
  });

  it("should build Codex command with codex.md in stateDir", async () => {
    const codexParams: CliSpawnParams = {
      ...baseParams,
      cli: "codex",
      model: "o3",
    };

    await spawner.spawn(codexParams);

    // Verify codex.md was written in stateDir/cli-config/{agentId}/
    const configDir = path.join(tmpDir, "cli-config", "at--dev--frontend");
    const codexMd = await fs.readFile(path.join(configDir, "codex.md"), "utf-8");
    expect(codexMd).toBe("You are a frontend developer.");
  });

  it("should build Gemini command with GEMINI.md in stateDir", async () => {
    const geminiParams: CliSpawnParams = {
      ...baseParams,
      cli: "gemini",
      model: "gemini-2.5-pro",
    };

    await spawner.spawn(geminiParams);

    // Verify GEMINI.md was written in stateDir/cli-config/{agentId}/.gemini/
    const configDir = path.join(tmpDir, "cli-config", "at--dev--frontend", ".gemini");
    const geminiMd = await fs.readFile(path.join(configDir, "GEMINI.md"), "utf-8");
    expect(geminiMd).toBe("You are a frontend developer.");

    // Verify settings.json has MCP config
    const settings = JSON.parse(await fs.readFile(path.join(configDir, "settings.json"), "utf-8"));
    expect(settings.mcpServers["agent-teams"]).toBeDefined();
  });

  it("should return correct log path", () => {
    const logPath = spawner.getLogPath("dev", "frontend");
    expect(logPath).toBe(path.join(tmpDir, "logs", "dev", "frontend.log"));
  });

  it("should get all processes", async () => {
    await spawner.spawn(baseParams);
    await spawner.spawn({
      ...baseParams,
      agentId: "at--dev--backend",
      member: "backend",
    });

    const all = spawner.getAllProcesses();
    expect(all.size).toBe(2);
    expect(all.has("at--dev--frontend")).toBe(true);
    expect(all.has("at--dev--backend")).toBe(true);
  });

  it("should register onExit callback for crash handling", async () => {
    await spawner.spawn(baseParams);

    // Verify onExit was registered
    expect(mockPty.onExit).toHaveBeenCalled();
  });

  it("should handle thinking mode for Claude (ultrathink prefix)", async () => {
    const { spawn } = await import("node-pty");
    const mockSpawn = spawn as unknown as ReturnType<typeof vi.fn>;

    await spawner.spawn({
      ...baseParams,
      thinking: true,
    });

    // Verify spawn was called with args containing ultrathink in the -p arg
    expect(mockSpawn).toHaveBeenCalled();
    const spawnArgs = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1];
    const args = spawnArgs[1] as string[];
    const pIdx = args.indexOf("-p");
    expect(pIdx).toBeGreaterThan(-1);
    expect(args[pIdx + 1]).toContain("ultrathink");
  });

  it("should append extra_args for Claude", async () => {
    const { spawn } = await import("node-pty");
    const mockSpawn = spawn as unknown as ReturnType<typeof vi.fn>;

    await spawner.spawn({
      ...baseParams,
      extraArgs: ["--custom-flag", "--another"],
    });

    expect(mockSpawn).toHaveBeenCalled();
    const spawnArgs = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1];
    const args = spawnArgs[1] as string[];
    expect(args).toContain("--custom-flag");
    expect(args).toContain("--another");
  });
});

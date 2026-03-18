/**
 * Initialize CLI agent infrastructure (IPC server + CLI spawner).
 *
 * Uses module-level singletons so the IPC server and CLI spawner survive
 * across gateway re-activations within the same process. Multiple
 * activate() calls share the same init promise and infrastructure.
 */

import * as path from "node:path";
import type { AgentTeamsConfig } from "../types.js";
import { isCliMember } from "../types.js";
import type { PluginRegistry } from "../registry.js";
import { IpcServer } from "../cli/ipc-server.js";
import { CliSpawner } from "../cli/cli-spawner.js";

// Module-level singletons — survive re-activation within same process
let _ipcServer: IpcServer | null = null;
let _cliSpawner: CliSpawner | null = null;
let _initPromise: Promise<void> | null = null;
let _cleanupRegistered = false;

/**
 * Create a lazy initializer for CLI infrastructure.
 * Returns a function that starts IPC server + CLI spawner on first call.
 * Subsequent calls (including from re-activations) are no-ops via
 * the module-level _initPromise.
 */
export function createLazyCliInit(
  config: AgentTeamsConfig,
  stateDir: string,
  registry: PluginRegistry,
  log: { info: (msg: string) => void },
): () => Promise<void> {
  return () => {
    // If CLI infra already exists, just ensure the spawner is on this registry
    if (_cliSpawner) {
      registry.cliSpawner = _cliSpawner;
      return _initPromise ?? Promise.resolve();
    }

    // If init is in-flight (from another activation), wait then copy spawner
    if (_initPromise) {
      return _initPromise.then(() => {
        if (_cliSpawner) registry.cliSpawner = _cliSpawner;
      });
    }

    _initPromise = initCliInfrastructure(config, stateDir, registry, log)
      .catch((err) => {
        _initPromise = null;
        throw err;
      });
    return _initPromise;
  };
}

/**
 * Start IPC server and CLI spawner if any team has CLI members.
 */
async function initCliInfrastructure(
  config: AgentTeamsConfig,
  stateDir: string,
  registry: PluginRegistry,
  log: { info: (msg: string) => void },
): Promise<void> {
  // Note: hasCliMembers check is done by the caller (index.ts) before
  // setting up the lazy init closure. No need to recheck here.
  const sockPath = path.join(stateDir, "ipc.sock");

  // Start IPC server (only once)
  if (!_ipcServer) {
    _ipcServer = new IpcServer(sockPath, registry);
    await _ipcServer.start();
    log.info(`IPC server started at ${sockPath}`);
  }

  // Initialize CLI spawner (only once)
  if (!_cliSpawner) {
    _cliSpawner = new CliSpawner(stateDir, _ipcServer.getEndpoint(), registry);
  }
  registry.cliSpawner = _cliSpawner;

  // Register process cleanup once.
  // IMPORTANT: Only kill CLI subprocesses, do NOT stop the IPC server or
  // delete the socket file. On gateway restart (SIGTERM), the new process
  // creates a new IPC server that unlinks the old socket before listening.
  // If we delete the socket here, a race condition occurs: old process
  // cleanup runs AFTER new process creates the socket, deleting it.
  if (!_cleanupRegistered) {
    _cleanupRegistered = true;
    const cleanup = () => {
      _cliSpawner?.killAll();
      _cliSpawner = null;
      _ipcServer = null;
      _initPromise = null;
      _cleanupRegistered = false;
    };
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }

  const cliMemberCount = Object.values(config.teams).reduce(
    (acc, tc) => acc + Object.values(tc.members).filter((m) => isCliMember(m)).length,
    0,
  );
  log.info(`CLI agent support enabled: ${cliMemberCount} CLI member(s) configured (on-demand spawn).`);
}

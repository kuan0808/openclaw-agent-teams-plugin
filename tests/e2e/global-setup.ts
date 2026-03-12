/**
 * Global setup for E2E tests.
 *
 * Runs once before all test files and performs a full gateway-aware reset.
 */

import { cleanAllState } from "./helpers/reset.js";

export async function setup(): Promise<void> {
  console.log("[e2e] Resetting gateway + plugin state...");
  await cleanAllState();
  console.log("[e2e] Setup complete.");
}

import { describe, expect, it, vi } from "vitest";

import { performGatewayAwareReset } from "../tests/e2e/helpers/reset.js";

describe("E2E reset helper", () => {
  it("cleans state before restarting the gateway", async () => {
    const steps: string[] = [];

    await performGatewayAwareReset({
      cleanStateFiles: () => {
        steps.push("clean");
      },
      runGatewayCommand: vi.fn(async (args: string[]) => {
        steps.push(args[0] ?? "unknown");
      }),
      waitForGatewayState: vi.fn(async (expectedUp: boolean) => {
        steps.push(expectedUp ? "wait-up" : "wait-down");
      }),
    });

    expect(steps).toEqual(["clean", "restart", "wait-up"]);
  });

  it("falls back to install when restart is unavailable", async () => {
    const steps: string[] = [];

    await performGatewayAwareReset({
      cleanStateFiles: () => {
        steps.push("clean");
      },
      runGatewayCommand: vi.fn(async (args: string[]) => {
        const command = args[0] ?? "unknown";
        steps.push(command);
        if (command === "restart") {
          throw new Error("service not loaded");
        }
      }),
      waitForGatewayState: vi.fn(async (expectedUp: boolean) => {
        steps.push(expectedUp ? "wait-up" : "wait-down");
      }),
    });

    expect(steps).toEqual(["clean", "restart", "install", "wait-up"]);
  });
});

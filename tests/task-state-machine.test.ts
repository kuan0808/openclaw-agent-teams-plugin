import { describe, it, expect } from "vitest";
import { validateTransition } from "../src/state/run-manager.js";
import type { TaskState } from "../src/types.js";

describe("validateTransition", () => {
  // ── Valid transitions ─────────────────────────────────────────────────

  it("BLOCKED → PENDING is valid", () => {
    expect(validateTransition("BLOCKED", "PENDING")).toBeNull();
  });

  it("BLOCKED → CANCELED is valid", () => {
    expect(validateTransition("BLOCKED", "CANCELED")).toBeNull();
  });

  it("PENDING → WORKING is valid", () => {
    expect(validateTransition("PENDING", "WORKING")).toBeNull();
  });

  it("PENDING → BLOCKED is valid", () => {
    expect(validateTransition("PENDING", "BLOCKED")).toBeNull();
  });

  it("PENDING → CANCELED is valid", () => {
    expect(validateTransition("PENDING", "CANCELED")).toBeNull();
  });

  it("WORKING → COMPLETED is valid", () => {
    expect(validateTransition("WORKING", "COMPLETED")).toBeNull();
  });

  it("WORKING → FAILED is valid", () => {
    expect(validateTransition("WORKING", "FAILED")).toBeNull();
  });

  it("WORKING → INPUT_REQUIRED is valid", () => {
    expect(validateTransition("WORKING", "INPUT_REQUIRED")).toBeNull();
  });

  it("WORKING → CANCELED is valid", () => {
    expect(validateTransition("WORKING", "CANCELED")).toBeNull();
  });

  it("INPUT_REQUIRED → WORKING is valid", () => {
    expect(validateTransition("INPUT_REQUIRED", "WORKING")).toBeNull();
  });

  it("INPUT_REQUIRED → FAILED is valid", () => {
    expect(validateTransition("INPUT_REQUIRED", "FAILED")).toBeNull();
  });

  it("INPUT_REQUIRED → CANCELED is valid", () => {
    expect(validateTransition("INPUT_REQUIRED", "CANCELED")).toBeNull();
  });

  it("FAILED → PENDING (retry) is valid", () => {
    expect(validateTransition("FAILED", "PENDING")).toBeNull();
  });

  // ── Invalid transitions ───────────────────────────────────────────────

  it("PENDING → COMPLETED is invalid (must go through WORKING)", () => {
    const err = validateTransition("PENDING", "COMPLETED");
    expect(err).toBeTypeOf("string");
    expect(err).toContain("Invalid task state transition");
    expect(err).toContain("PENDING");
    expect(err).toContain("COMPLETED");
  });

  it("BLOCKED → WORKING is invalid (must go through PENDING)", () => {
    const err = validateTransition("BLOCKED", "WORKING");
    expect(err).toBeTypeOf("string");
    expect(err).toContain("Invalid task state transition");
  });

  it("BLOCKED → COMPLETED is invalid", () => {
    const err = validateTransition("BLOCKED", "COMPLETED");
    expect(err).toBeTypeOf("string");
  });

  it("WORKING → PENDING is invalid (no going back)", () => {
    const err = validateTransition("WORKING", "PENDING");
    expect(err).toBeTypeOf("string");
  });

  it("FAILED → WORKING is invalid (must retry via PENDING)", () => {
    const err = validateTransition("FAILED", "WORKING");
    expect(err).toBeTypeOf("string");
  });

  it("FAILED → COMPLETED is invalid", () => {
    const err = validateTransition("FAILED", "COMPLETED");
    expect(err).toBeTypeOf("string");
  });

  // ── Terminal states reject all transitions ────────────────────────────

  it("COMPLETED rejects all transitions", () => {
    const allStates: TaskState[] = [
      "BLOCKED", "PENDING", "WORKING", "INPUT_REQUIRED",
      "COMPLETED", "FAILED", "CANCELED",
    ];

    for (const to of allStates) {
      const err = validateTransition("COMPLETED", to);
      expect(err).toBeTypeOf("string");
      expect(err).toContain("terminal state");
    }
  });

  it("CANCELED rejects all transitions", () => {
    const allStates: TaskState[] = [
      "BLOCKED", "PENDING", "WORKING", "INPUT_REQUIRED",
      "COMPLETED", "FAILED", "CANCELED",
    ];

    for (const to of allStates) {
      const err = validateTransition("CANCELED", to);
      expect(err).toBeTypeOf("string");
      expect(err).toContain("terminal state");
    }
  });

  // ── Error message format ──────────────────────────────────────────────

  it("error message includes the allowed transitions", () => {
    const err = validateTransition("PENDING", "COMPLETED");
    expect(err).toContain("WORKING");
    expect(err).toContain("BLOCKED");
    expect(err).toContain("CANCELED");
  });
});

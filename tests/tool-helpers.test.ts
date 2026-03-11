import { describe, it, expect } from "vitest";
import { collectLearnings } from "../src/tools/tool-helpers.js";

describe("collectLearnings (enhanced)", () => {
  function makeKv(entries: Array<{ key: string; value: unknown }>) {
    const map = new Map(entries.map((e) => [e.key, e]));
    return {
      *iterEntries() {
        for (const [key, entry] of map) {
          yield [key, entry] as [string, { key: string; value: unknown }];
        }
      },
    };
  }

  it("should collect legacy flat learnings", () => {
    const kv = makeKv([
      { key: "learnings:api-calls", value: "Always retry on 429" },
      { key: "learnings:testing", value: "Mock external deps" },
      { key: "other:stuff", value: "ignored" },
    ]);

    const result = collectLearnings(kv);
    expect(result).toHaveLength(2);
    expect(result[0]!.key).toBe("api-calls");
    expect(result[0]!.value).toBe("Always retry on 429");
  });

  it("should collect structured learnings with confidence", () => {
    const kv = makeKv([
      {
        key: "learnings:failure:task-1",
        value: { content: "Failed due to timeout", confidence: 0.9, category: "failure", timestamp: 1 },
      },
      {
        key: "learnings:pattern:auth",
        value: { content: "Use JWT for auth", confidence: 0.6, category: "pattern", timestamp: 2 },
      },
    ]);

    const result = collectLearnings(kv);
    expect(result).toHaveLength(2);
    // Sorted by confidence descending
    expect(result[0]!.confidence).toBe(0.9);
    expect(result[0]!.category).toBe("failure");
    expect(result[1]!.confidence).toBe(0.6);
    expect(result[1]!.category).toBe("pattern");
  });

  it("should sort by confidence descending", () => {
    const kv = makeKv([
      { key: "learnings:a", value: { content: "Low", confidence: 0.3, category: "insight", timestamp: 1 } },
      { key: "learnings:b", value: { content: "High", confidence: 0.95, category: "fix", timestamp: 2 } },
      { key: "learnings:c", value: { content: "Med", confidence: 0.7, category: "pattern", timestamp: 3 } },
    ]);

    const result = collectLearnings(kv);
    expect(result[0]!.value).toBe("High");
    expect(result[1]!.value).toBe("Med");
    expect(result[2]!.value).toBe("Low");
  });

  it("should respect limit parameter", () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      key: `learnings:item-${i}`,
      value: `Learning ${i}`,
    }));
    const kv = makeKv(entries);

    const result = collectLearnings(kv, 5);
    expect(result).toHaveLength(5);
  });

  it("should default limit to 10", () => {
    const entries = Array.from({ length: 15 }, (_, i) => ({
      key: `learnings:item-${i}`,
      value: `Learning ${i}`,
    }));
    const kv = makeKv(entries);

    const result = collectLearnings(kv);
    expect(result).toHaveLength(10);
  });

  it("should handle mixed legacy and structured entries", () => {
    const kv = makeKv([
      { key: "learnings:old-style", value: "Use caching" },
      { key: "learnings:failure:new-style", value: { content: "Check disk space", confidence: 0.8, category: "failure", timestamp: 1 } },
    ]);

    const result = collectLearnings(kv);
    expect(result).toHaveLength(2);
    // Structured (0.8) should come before legacy (0.5 default)
    expect(result[0]!.value).toBe("Check disk space");
    expect(result[0]!.confidence).toBe(0.8);
    expect(result[1]!.value).toBe("Use caching");
    expect(result[1]!.confidence).toBe(0.5);
  });
});

import { describe, it, expect } from "vitest";
import { slugify, unslugify, makeAgentId, parseAgentId, isTeamAgent } from "../src/types.js";

describe("slugify / unslugify", () => {
  it("passes through ASCII-safe strings unchanged", () => {
    expect(slugify("dev")).toBe("dev");
    expect(slugify("my-team")).toBe("my-team");
    expect(slugify("worker_1")).toBe("worker_1");
  });

  it("lowercases ASCII strings", () => {
    expect(slugify("Dev")).toBe("dev");
    expect(slugify("MyTeam")).toBe("myteam");
  });

  it("encodes Chinese characters as 0u + underscore-separated hex", () => {
    expect(slugify("文淵閣")).toBe("0u6587_6df5_95a3");
    expect(slugify("掌閣")).toBe("0u638c_95a3");
  });

  it("unslugify reverses encoded strings", () => {
    expect(unslugify("0u6587_6df5_95a3")).toBe("文淵閣");
    expect(unslugify("0u638c_95a3")).toBe("掌閣");
  });

  it("unslugify passes through ASCII strings", () => {
    expect(unslugify("dev")).toBe("dev");
    expect(unslugify("my-team")).toBe("my-team");
  });

  it("unslugify passes through strings that don't match encoded format", () => {
    expect(unslugify("node")).toBe("node");
    expect(unslugify("0ubuntu")).toBe("0ubuntu");
    // Contains non-hex chars after 0u
    expect(unslugify("0uzzzz")).toBe("0uzzzz");
  });

  it("roundtrips non-ASCII strings", () => {
    const names = ["文淵閣", "掌閣", "尋卷", "明鑒", "執墨", "チーム", "팀"];
    for (const name of names) {
      expect(unslugify(slugify(name))).toBe(name);
    }
  });

  it("roundtrips ASCII strings", () => {
    const names = ["dev", "worker-1", "my_team"];
    for (const name of names) {
      expect(unslugify(slugify(name))).toBe(name);
    }
  });

  it("handles supplementary characters (emoji)", () => {
    const slug = slugify("😀");
    expect(slug).toBe("0u1f600");
    expect(unslugify(slug)).toBe("😀");
  });

  it("roundtrips mixed emoji and CJK", () => {
    const s = "文😀閣";
    expect(unslugify(slugify(s))).toBe(s);
  });
});

describe("makeAgentId / parseAgentId with non-ASCII", () => {
  it("produces ASCII-safe agent IDs for Chinese names", () => {
    const id = makeAgentId("文淵閣", "掌閣");
    // Only [a-z0-9_] in slugified parts (no dashes within slugs, dashes are separators)
    expect(id).toContain("at--0u");
    expect(id).toBe("at--0u6587_6df5_95a3--0u638c_95a3");
  });

  it("preserves ASCII names unchanged", () => {
    expect(makeAgentId("dev", "worker")).toBe("at--dev--worker");
  });

  it("parseAgentId decodes back to original names", () => {
    const id = makeAgentId("文淵閣", "掌閣");
    const parsed = parseAgentId(id);
    expect(parsed).toEqual({ team: "文淵閣", member: "掌閣" });
  });

  it("parseAgentId works for ASCII names", () => {
    const parsed = parseAgentId("at--dev--worker");
    expect(parsed).toEqual({ team: "dev", member: "worker" });
  });

  it("parseAgentId handles legacy non-ASCII IDs (backward compat)", () => {
    const parsed = parseAgentId("at--文淵閣--掌閣");
    expect(parsed).toEqual({ team: "文淵閣", member: "掌閣" });
  });

  it("isTeamAgent works for both old and new format", () => {
    expect(isTeamAgent("at--dev--worker")).toBe(true);
    expect(isTeamAgent("at--0u6587_6df5_95a3--0u638c_95a3")).toBe(true);
    expect(isTeamAgent("at--文淵閣--掌閣")).toBe(true);
    expect(isTeamAgent("main")).toBe(false);
    expect(isTeamAgent("at")).toBe(false);
    expect(isTeamAgent(undefined)).toBe(false);
  });
});

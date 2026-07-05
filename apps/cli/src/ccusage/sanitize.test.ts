import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { sanitizeSessionReport } from "./sanitize";

/**
 * Mirrors `ccusage claude session --json` v20: `sessionId` and `projectPath`
 * both encode the local project directory path.
 */
const claudeSession = {
  sessionId: "-Users-alexandru-repos-tokenmaxxing",
  projectPath: "-Users-alexandru-repos-tokenmaxxing",
  inputTokens: 355_038,
  outputTokens: 1_438_433,
  cacheCreationTokens: 6_058_989,
  cacheReadTokens: 652_827_808,
  totalTokens: 660_680_268,
  totalCost: 851.14,
  lastActivity: "2026-06-10",
  versions: ["1.0.24"],
  modelsUsed: ["claude-haiku-4-5-20251001"],
  modelBreakdowns: [
    {
      modelName: "claude-haiku-4-5-20251001",
      inputTokens: 6_637,
      outputTokens: 327_616,
      cacheCreationTokens: 2_865_086,
      cacheReadTokens: 46_241_604,
      cost: 9.85,
      // Hypothetical future field: must be dropped, not passed through.
      transcriptPath: "/Users/alexandru/.claude/projects/foo/transcript.jsonl",
    },
  ],
};

function expectedHash(identifier: string): string {
  return createHash("sha256").update(identifier).digest("hex").slice(0, 16);
}

describe("sanitizeSessionReport", () => {
  it("keeps only allowlisted aggregates and hashes the path-derived sessionId", () => {
    const report = sanitizeSessionReport({ sessions: [claudeSession] });

    expect(report.sessions).toHaveLength(1);
    expect(report.sessions[0]).toEqual({
      cacheCreationTokens: 6_058_989,
      cacheReadTokens: 652_827_808,
      inputTokens: 355_038,
      lastActivity: "2026-06-10",
      modelBreakdowns: [
        {
          cacheCreationTokens: 2_865_086,
          cacheReadTokens: 46_241_604,
          cost: 9.85,
          inputTokens: 6_637,
          modelName: "claude-haiku-4-5-20251001",
          outputTokens: 327_616,
        },
      ],
      modelsUsed: ["claude-haiku-4-5-20251001"],
      outputTokens: 1_438_433,
      sessionId: expectedHash("-Users-alexandru-repos-tokenmaxxing"),
      totalCost: 851.14,
      totalTokens: 660_680_268,
      versions: ["1.0.24"],
    });
  });

  it("leaves no path substrings anywhere in the serialized payload", () => {
    const serialized = JSON.stringify(sanitizeSessionReport({ sessions: [claudeSession] }));

    expect(serialized).not.toContain("Users");
    expect(serialized).not.toContain("alexandru");
    expect(serialized).not.toContain("tokenmaxxing");
    expect(serialized).not.toContain("projectPath");
    expect(serialized).not.toContain("transcriptPath");
  });

  it("replaces the sessionId with a non-reversible fixed-length hex hash", () => {
    const report = sanitizeSessionReport({ sessions: [claudeSession] });
    const sessionId = report.sessions[0]?.sessionId;

    expect(sessionId).toMatch(/^[0-9a-f]{16}$/);
    expect(sessionId).not.toBe(claudeSession.sessionId);
  });

  it("hashes codex-style sessionFile identifiers into sessionId", () => {
    const report = sanitizeSessionReport({
      sessions: [
        {
          sessionFile: "rollout-2026-02-09T12-05-23",
          totalTokens: 5_000,
          costUSD: 0.5,
        },
      ],
    });

    expect(report.sessions[0]).toEqual({
      costUSD: 0.5,
      sessionId: expectedHash("rollout-2026-02-09T12-05-23"),
      totalTokens: 5_000,
    });
  });

  it("drops unknown fields, non-record entries, and path-shaped timestamps", () => {
    const report = sanitizeSessionReport({
      sessions: [
        {
          sessionId: "abc",
          lastActivity: "/Users/alexandru/repos",
          project: "secret-client-project",
          cwd: "/Users/alexandru/repos/secret",
          inputTokens: Number.NaN,
          outputTokens: 42,
        },
        "not-a-record",
        null,
      ],
    });

    expect(report.sessions).toHaveLength(1);
    expect(report.sessions[0]).toEqual({
      outputTokens: 42,
      sessionId: expectedHash("abc"),
    });
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import type { AntigravityUsageEvent } from "./protobuf";
import {
  antigravityDailyCommand,
  antigravitySessionCommand,
  buildFallbackDailyReport,
  collectAntigravityUsage,
  enrichDailyReport,
  resolveConversationDirectories,
} from "./runner";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

function encodeVarint(value: number): Uint8Array {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (remaining > 0);
  return Uint8Array.from(bytes);
}

function joinBytes(...values: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(values.reduce((total, value) => total + value.length, 0));
  let offset = 0;
  for (const value of values) {
    output.set(value, offset);
    offset += value.length;
  }
  return output;
}

function varintField(field: number, value: number): Uint8Array {
  return joinBytes(encodeVarint(field << 3), encodeVarint(value));
}

function bytesField(field: number, value: Uint8Array): Uint8Array {
  return joinBytes(encodeVarint((field << 3) | 2), encodeVarint(value.length), value);
}

function stringField(field: number, value: string): Uint8Array {
  return bytesField(field, new TextEncoder().encode(value));
}

function generationBlob(): Uint8Array {
  const usage = joinBytes(
    varintField(1, 1_132),
    varintField(2, 500),
    varintField(5, 16_000),
    varintField(9, 300),
    varintField(10, 40),
    stringField(11, "response-1"),
  );
  return bytesField(1, joinBytes(bytesField(4, usage), stringField(19, "gemini-3-flash-agent")));
}

function usageEvent(overrides: Partial<AntigravityUsageEvent> = {}): AntigravityUsageEvent {
  return {
    cacheReadTokens: 16_000,
    inputTokens: 1_632,
    model: "gemini-3.5-flash-high",
    outputTokens: 300,
    reasoningTokens: 40,
    responseId: "response-1",
    sessionId: "session-1",
    timestampMs: new Date(2026, 6, 21, 12).getTime(),
    totalTokens: 17_972,
    ...overrides,
  };
}

describe("Antigravity local collector", () => {
  it("uses the documented config root and GEMINI_CLI_HOME override", () => {
    expect(resolveConversationDirectories({}, "/Users/alex")).toEqual([
      "/Users/alex/.gemini/antigravity-cli/conversations",
    ]);
    expect(resolveConversationDirectories({ GEMINI_CLI_HOME: "/tmp/alex" }, "/Users/alex")).toEqual(
      ["/tmp/alex/.gemini/antigravity-cli/conversations"],
    );
  });

  it("reads a database without the optional trajectory table and deduplicates paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tokenmaxxing-antigravity-test-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "session-1.db");
    const database = new DatabaseSync(path);
    try {
      database.exec("CREATE TABLE gen_metadata (idx INTEGER, data BLOB, size INTEGER)");
      database
        .prepare("INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)")
        .run(0, generationBlob(), generationBlob().byteLength);
    } finally {
      database.close();
    }

    const collection = await Effect.runPromise(
      collectAntigravityUsage({ conversationDirectories: [directory, directory] }),
    );

    expect(collection.sessionCount).toBe(1);
    expect(collection.events).toHaveLength(1);
    expect(collection.events[0]).toMatchObject({
      inputTokens: 1_632,
      model: "gemini-3.5-flash-high",
      reasoningTokens: 40,
      totalTokens: 17_972,
    });
    expect(collection.events[0]?.timestampMs).toBeGreaterThan(0);
  });

  it("preserves reasoning-inclusive totals in priced and fallback reports", () => {
    const event = usageEvent();
    const enriched = enrichDailyReport(
      {
        daily: [
          {
            date: "2026-07-21",
            modelBreakdowns: [
              {
                cacheReadTokens: 16_000,
                inputTokens: 1_632,
                modelName: "gemini-3.5-flash-high",
                outputTokens: 300,
              },
            ],
            totalTokens: 17_972,
          },
        ],
      },
      [event],
    );
    expect(enriched.daily[0]?.modelBreakdowns?.[0]).toMatchObject({
      reasoningTokens: 40,
      totalTokens: 17_972,
    });

    expect(buildFallbackDailyReport([event]).daily[0]).toMatchObject({
      cacheReadTokens: 16_000,
      inputTokens: 1_632,
      outputTokens: 300,
      totalTokens: 17_972,
    });
  });

  it("saturates aggregate totals", () => {
    const report = buildFallbackDailyReport([
      usageEvent({
        cacheReadTokens: Number.MAX_SAFE_INTEGER,
        inputTokens: Number.MAX_SAFE_INTEGER,
        outputTokens: Number.MAX_SAFE_INTEGER,
        reasoningTokens: Number.MAX_SAFE_INTEGER,
        totalTokens: Number.MAX_SAFE_INTEGER,
      }),
      usageEvent({ responseId: "response-2" }),
    ]);

    expect(report.daily[0]).toMatchObject({
      cacheReadTokens: Number.MAX_SAFE_INTEGER,
      inputTokens: Number.MAX_SAFE_INTEGER,
      outputTokens: Number.MAX_SAFE_INTEGER,
      totalTokens: Number.MAX_SAFE_INTEGER,
    });
  });

  it("describes direct collector provenance in raw reports", () => {
    expect(antigravityDailyCommand({ since: "2026-07-01" })).toEqual([
      "tokenmaxxing",
      "antigravity",
      "daily",
      "--format",
      "sqlite-protobuf-v1",
      "--since",
      "2026-07-01",
    ]);
    expect(antigravitySessionCommand()).toEqual([
      "tokenmaxxing",
      "antigravity",
      "session",
      "--count-only",
    ]);
  });
});

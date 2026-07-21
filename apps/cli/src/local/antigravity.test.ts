import { mkdirSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { aggregateGenerations, collectAntigravityUsage, parseGenMetadata } from "./antigravity";

const TS_1 = 1_784_660_861; // 2026-07-21T19:07:41Z
const TS_2 = 1_784_670_000;

function varint(value: number): number[] {
  const bytes: number[] = [];
  let remaining = BigInt(value);
  while (remaining > 0x7fn) {
    bytes.push(Number(remaining & 0x7fn) | 0x80);
    remaining >>= 7n;
  }
  bytes.push(Number(remaining));

  return bytes;
}

function varintField(field: number, value: number): number[] {
  return [...varint((field << 3) | 0), ...varint(value)];
}

function bytesField(field: number, data: Uint8Array): number[] {
  return [...varint((field << 3) | 2), ...varint(data.length), ...data];
}

function stringField(field: number, value: string): number[] {
  return bytesField(field, new TextEncoder().encode(value));
}

function messageField(field: number, parts: number[][]): number[] {
  return bytesField(field, new Uint8Array(parts.flat()));
}

/** Mirrors the reverse-engineered agy 1.1.x gen_metadata wire shape. */
function genMetadataBlob(model: string, ts: number, usage: number[][]): Uint8Array {
  return new Uint8Array(
    messageField(1, [
      messageField(4, usage),
      messageField(9, [messageField(4, [varintField(1, ts)])]),
      stringField(19, model),
    ]),
  );
}

function pricingResponse() {
  return {
    data: [
      {
        id: "anthropic/claude-sonnet-4.6",
        pricing: { completion: "0.000015", input_cache_read: "0.0000003", prompt: "0.000003" },
      },
    ],
  };
}

function okFetch() {
  return () => Promise.resolve(new Response(JSON.stringify(pricingResponse()), { status: 200 }));
}

describe("parseGenMetadata", () => {
  it("extracts model, timestamp, and token usage", () => {
    const blob = genMetadataBlob("claude-sonnet-4-6", TS_1, [
      varintField(2, 19_346),
      varintField(3, 219),
      varintField(5, 18_814),
    ]);

    expect(parseGenMetadata(blob)).toEqual({
      cacheReadTokens: 18_814,
      inputTokens: 19_346,
      model: "claude-sonnet-4-6",
      outputTokens: 219,
      ts: TS_1,
    });
  });

  it("defaults missing cached tokens to zero", () => {
    const blob = genMetadataBlob("gemini-3.6-flash", TS_1, [
      varintField(2, 18_184),
      varintField(3, 500),
    ]);

    expect(parseGenMetadata(blob)?.cacheReadTokens).toBe(0);
  });

  it("rejects blobs that drifted from the known shape", () => {
    // No usage message.
    expect(
      parseGenMetadata(
        new Uint8Array(
          messageField(1, [
            messageField(9, [messageField(4, [varintField(1, TS_1)])]),
            stringField(19, "claude-sonnet-4-6"),
          ]),
        ),
      ),
    ).toBeNull();
    // No timestamp.
    expect(
      parseGenMetadata(
        new Uint8Array(
          messageField(1, [
            messageField(4, [varintField(2, 10), varintField(3, 5)]),
            stringField(19, "claude-sonnet-4-6"),
          ]),
        ),
      ),
    ).toBeNull();
    // Model field is not a printable model id.
    expect(
      parseGenMetadata(
        new Uint8Array(
          messageField(1, [
            messageField(4, [varintField(2, 10), varintField(3, 5)]),
            messageField(9, [messageField(4, [varintField(1, TS_1)])]),
            bytesField(19, new Uint8Array([0xff, 0x00, 0x01])),
          ]),
        ),
      ),
    ).toBeNull();
    // Garbage.
    expect(parseGenMetadata(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe("aggregateGenerations", () => {
  const pricing = {
    claudesonnet46: { completion: 0.000015, inputCacheRead: 0.0000003, prompt: 0.000003 },
  };

  it("buckets by day and prices via the OpenRouter table", () => {
    const dayOf = (ts: number) => (ts < TS_2 ? "2026-07-21" : "2026-07-22");
    const days = aggregateGenerations(
      [
        {
          cacheReadTokens: 0,
          inputTokens: 100_000,
          model: "claude-sonnet-4-6",
          outputTokens: 10_000,
          ts: TS_1,
        },
        {
          cacheReadTokens: 0,
          inputTokens: 2_000,
          model: "unknown-future-model",
          outputTokens: 50,
          ts: TS_1,
        },
      ],
      { dayOf, pricing },
    );

    expect(days).toHaveLength(1);
    const [claude, unknown] = days[0]!.modelBreakdowns!;
    expect(claude).toMatchObject({
      cacheReadTokens: 0,
      inputTokens: 100_000,
      modelName: "claude-sonnet-4-6",
      outputTokens: 10_000,
    });
    // 100_000*3e-6 + 10_000*15e-6, rounded to cents.
    expect(claude?.cost).toBe(0.45);
    // Unpriced models report tokens at cost 0.
    expect(unknown).toMatchObject({
      cost: 0,
      inputTokens: 2_000,
      modelName: "unknown-future-model",
    });
  });
});

describe("collectAntigravityUsage", () => {
  let home: string;
  let cacheDir: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "tokenmaxxing-agy-home-"));
    cacheDir = await mkdtemp(join(tmpdir(), "tokenmaxxing-agy-cache-"));
  });

  afterEach(async () => {
    await rm(home, { force: true, recursive: true });
    await rm(cacheDir, { force: true, recursive: true });
  });

  function writeConversationDb(name: string, blobs: Uint8Array[]): void {
    const dir = join(home, "conversations");
    mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(join(dir, name));
    db.exec("CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)");
    for (const [idx, blob] of blobs.entries()) {
      db.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)").run(idx, blob);
    }
    db.close();
  }

  it("returns empty when the conversations dir is missing", async () => {
    expect(await collectAntigravityUsage({ cacheDir, home })).toEqual({
      days: [],
      sessionIds: [],
    });
  });

  it("aggregates generations across conversation databases", async () => {
    await mkdir(join(home, "conversations"), { recursive: true });
    writeConversationDb("conv-a.db", [
      genMetadataBlob("claude-sonnet-4-6", TS_1, [varintField(2, 100_000), varintField(3, 10_000)]),
    ]);
    writeConversationDb("conv-b.db", [
      genMetadataBlob("claude-sonnet-4-6", TS_1, [varintField(2, 200_000), varintField(3, 20_000)]),
      // Drifted shape — skipped, not fatal.
      new Uint8Array([9, 9, 9]),
    ]);

    const report = await collectAntigravityUsage({
      cacheDir,
      dayOf: () => "2026-07-21",
      fetchFn: okFetch(),
      home,
    });

    expect(report.sessionIds).toEqual(["conv-a", "conv-b"]);
    expect(report.days).toHaveLength(1);
    expect(report.days[0]?.modelBreakdowns?.[0]).toMatchObject({
      inputTokens: 300_000,
      modelName: "claude-sonnet-4-6",
      outputTokens: 30_000,
    });
    // 300_000*3e-6 + 30_000*15e-6, rounded to cents.
    expect(report.days[0]?.modelBreakdowns?.[0]?.cost).toBe(1.35);
  });

  it("does not fetch pricing when there is no data", async () => {
    await mkdir(join(home, "conversations"), { recursive: true });
    let fetched = false;
    const fetchFn = () => {
      fetched = true;
      return Promise.resolve(new Response("{}", { status: 200 }));
    };

    const report = await collectAntigravityUsage({ cacheDir, fetchFn, home });

    expect(report).toEqual({ days: [], sessionIds: [] });
    expect(fetched).toBe(false);
  });
});

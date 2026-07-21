import { describe, expect, it } from "vitest";

import {
  normalizeAntigravityModel,
  parseAntigravityGeneration,
  parseAntigravitySessionTimestamp,
} from "./protobuf";

function encodeVarint(value: bigint): Uint8Array {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining > 0n) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (remaining > 0n);
  return Uint8Array.from(bytes);
}

function varintField(field: number, value: bigint | number): Uint8Array {
  return joinBytes(encodeVarint(BigInt(field << 3)), encodeVarint(BigInt(value)));
}

function bytesField(field: number, value: Uint8Array): Uint8Array {
  return joinBytes(
    encodeVarint(BigInt((field << 3) | 2)),
    encodeVarint(BigInt(value.length)),
    value,
  );
}

function stringField(field: number, value: string): Uint8Array {
  return bytesField(field, new TextEncoder().encode(value));
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

function timestamp(seconds: number, nanos = 0): Uint8Array {
  return joinBytes(varintField(1, seconds), varintField(2, nanos));
}

function generation(
  options: {
    cacheRead?: bigint | number;
    fixedInput?: bigint | number;
    generatedAt?: Uint8Array;
    model?: string;
    newInput?: bigint | number;
    output?: bigint | number;
    reasoning?: bigint | number;
    responseId?: string;
  } = {},
): Uint8Array {
  const usage = joinBytes(
    varintField(1, options.fixedInput ?? 1_132),
    varintField(2, options.newInput ?? 500),
    varintField(5, options.cacheRead ?? 16_000),
    varintField(9, options.output ?? 300),
    varintField(10, options.reasoning ?? 40),
    stringField(11, options.responseId ?? "response-1"),
  );
  const chatModel = joinBytes(
    bytesField(4, usage),
    ...(options.generatedAt === undefined
      ? []
      : [bytesField(9, bytesField(4, options.generatedAt))]),
    stringField(19, options.model ?? "gemini-3-flash-agent"),
  );
  return bytesField(1, chatModel);
}

describe("Antigravity protobuf usage parser", () => {
  it("extracts token counters, canonical model, response ID, and generation time", () => {
    const seen = new Set<string>();
    const event = parseAntigravityGeneration(
      generation({ generatedAt: timestamp(1_784_658_400, 250_000_000) }),
      "session-1",
      111_000,
      seen,
    );

    expect(event).toEqual({
      cacheReadTokens: 16_000,
      inputTokens: 1_632,
      model: "gemini-3.5-flash-high",
      outputTokens: 300,
      reasoningTokens: 40,
      responseId: "response-1",
      sessionId: "session-1",
      timestampMs: 1_784_658_400_250,
      totalTokens: 17_972,
    });
    expect(parseAntigravityGeneration(generation(), "session-1", 111_000, seen)).toBeUndefined();
  });

  it("normalizes both observed Antigravity model aliases", () => {
    expect(normalizeAntigravityModel("gemini-pro-default")).toBe("gemini-3.1-pro");
    expect(normalizeAntigravityModel("MODEL_PLACEHOLDER_M16")).toBe("gemini-3.1-pro");
    expect(normalizeAntigravityModel("gemini-3-flash-a")).toBe("gemini-3.5-flash-high");
    expect(normalizeAntigravityModel("gemini-3-flash-agent")).toBe("gemini-3.5-flash-high");
    expect(normalizeAntigravityModel("gemini-3.5-flash-low")).toBe("gemini-3.5-flash-medium");
    expect(normalizeAntigravityModel("gemini-2.5-pro")).toBe("gemini-2.5-pro");
  });

  it("uses session timestamps as a fallback and rejects malformed or empty usage", () => {
    expect(parseAntigravitySessionTimestamp(bytesField(2, timestamp(1_784_658_400)))).toBe(
      1_784_658_400_000,
    );
    expect(parseAntigravityGeneration(generation(), "session-1", 222_000)?.timestampMs).toBe(
      222_000,
    );
    expect(parseAntigravityGeneration(new Uint8Array(), "session-1", 222_000)).toBeUndefined();
    expect(
      parseAntigravityGeneration(
        generation({ cacheRead: 0, fixedInput: 0, newInput: 0, output: 0, reasoning: 0 }),
        "session-1",
        222_000,
      ),
    ).toBeUndefined();
  });

  it("saturates hostile token counters instead of overflowing safe integers", () => {
    const event = parseAntigravityGeneration(
      generation({
        cacheRead: (1n << 64n) - 1n,
        fixedInput: (1n << 64n) - 1n,
        newInput: 10,
        output: (1n << 64n) - 1n,
      }),
      "session-1",
      222_000,
    );

    expect(event?.inputTokens).toBe(Number.MAX_SAFE_INTEGER);
    expect(event?.cacheReadTokens).toBe(Number.MAX_SAFE_INTEGER);
    expect(event?.outputTokens).toBe(Number.MAX_SAFE_INTEGER);
    expect(event?.totalTokens).toBe(Number.MAX_SAFE_INTEGER);
  });
});

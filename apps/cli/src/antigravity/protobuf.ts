const MAX_SAFE_TOKEN_COUNT = Number.MAX_SAFE_INTEGER;

const ANTIGRAVITY_MODEL_ALIASES: Readonly<Record<string, string>> = {
  "gemini-3-flash-a": "gemini-3.5-flash-high",
  "gemini-3-flash-agent": "gemini-3.5-flash-high",
  "gemini-3-flash-b": "gemini-3.5-flash-high",
  "gemini-3-flash-c": "gemini-3-flash-preview",
  "gemini-3.5-flash-low": "gemini-3.5-flash-medium",
  "gemini-pro-agent": "gemini-3.1-pro",
  "gemini-pro-default": "gemini-3.1-pro",
  model_openai_gpt_oss_120b_medium: "gpt-oss-120b-medium",
  model_placeholder_m16: "gemini-3.1-pro",
  model_placeholder_m18: "gemini-3-flash-preview",
  model_placeholder_m20: "gemini-3.5-flash-medium",
  model_placeholder_m26: "claude-opus-4-6",
  model_placeholder_m35: "claude-sonnet-4-6",
  model_placeholder_m36: "gemini-3.1-pro",
  model_placeholder_m37: "gemini-3.1-pro",
  model_placeholder_m47: "gemini-3-flash-preview",
  model_placeholder_m84: "gemini-3-flash-preview",
  model_placeholder_m132: "gemini-3.5-flash-high",
  model_placeholder_m133: "gemini-3.5-flash-high",
  model_placeholder_m187: "gemini-3.5-flash-extra-low",
};

interface AntigravityUsageEvent {
  cacheReadTokens: number;
  inputTokens: number;
  model: string;
  outputTokens: number;
  reasoningTokens: number;
  responseId?: string | undefined;
  sessionId: string;
  timestampMs: number;
  totalTokens: number;
}

type WireValue =
  | { kind: "bytes"; value: Uint8Array }
  | { kind: "fixed" }
  | { kind: "varint"; value: bigint };

/**
 * Minimal reader for the token-bearing fields in Antigravity CLI v1.1.x
 * GeneratorMetadata protobufs. Google does not publish this message schema;
 * the field map is deliberately isolated here so format drift fails closed.
 * Field discovery and safety cases are adapted from Tokscale's MIT-licensed
 * parser at commit b1e76117ce81820e76c890e8d9728aea8114bfb4.
 */
class ProtobufReader {
  readonly #buffer: Uint8Array;
  #position = 0;

  constructor(buffer: Uint8Array) {
    this.#buffer = buffer;
  }

  nextField(): { field: number; value: WireValue } | undefined {
    if (this.#position >= this.#buffer.length) {
      return undefined;
    }

    const tag = this.#readVarint();
    if (tag === undefined) {
      return undefined;
    }

    const field = Number(tag >> 3n);
    if (!Number.isSafeInteger(field) || field <= 0) {
      return undefined;
    }

    const wireType = Number(tag & 0x7n);
    if (wireType === 0) {
      const value = this.#readVarint();
      return value === undefined ? undefined : { field, value: { kind: "varint", value } };
    }

    if (wireType === 1) {
      return this.#skip(8) ? { field, value: { kind: "fixed" } } : undefined;
    }

    if (wireType === 2) {
      const rawLength = this.#readVarint();
      if (rawLength === undefined || rawLength > BigInt(Number.MAX_SAFE_INTEGER)) {
        return undefined;
      }

      const length = Number(rawLength);
      const end = this.#position + length;
      if (!Number.isSafeInteger(end) || end > this.#buffer.length) {
        return undefined;
      }

      const value = this.#buffer.subarray(this.#position, end);
      this.#position = end;
      return { field, value: { kind: "bytes", value } };
    }

    if (wireType === 5) {
      return this.#skip(4) ? { field, value: { kind: "fixed" } } : undefined;
    }

    return undefined;
  }

  #readVarint(): bigint | undefined {
    let result = 0n;
    let shift = 0n;
    while (shift < 64n) {
      const byte = this.#buffer[this.#position];
      if (byte === undefined) {
        return undefined;
      }

      this.#position += 1;
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        return result;
      }

      shift += 7n;
    }

    return undefined;
  }

  #skip(length: number): boolean {
    const end = this.#position + length;
    if (!Number.isSafeInteger(end) || end > this.#buffer.length) {
      return false;
    }

    this.#position = end;
    return true;
  }
}

function parseAntigravityGeneration(
  blob: Uint8Array,
  sessionId: string,
  fallbackTimestampMs: number,
  seenResponseIds: Set<string> = new Set(),
): AntigravityUsageEvent | undefined {
  const chatModel = bytesField(blob, 1);
  const usage = chatModel === undefined ? undefined : bytesField(chatModel, 4);
  if (chatModel === undefined || usage === undefined) {
    return undefined;
  }

  const inputTokens = saturatingAdd(
    tokenCount(varintField(usage, 1)),
    tokenCount(varintField(usage, 2)),
  );
  const cacheReadTokens = tokenCount(varintField(usage, 5));
  const outputTokens = tokenCount(varintField(usage, 9));
  const reasoningTokens = tokenCount(varintField(usage, 10));
  if (inputTokens === 0 && cacheReadTokens === 0 && outputTokens === 0 && reasoningTokens === 0) {
    return undefined;
  }

  const responseId = stringField(usage, 11)?.trim();
  if (responseId !== undefined && responseId.length > 0) {
    if (seenResponseIds.has(responseId)) {
      return undefined;
    }
    seenResponseIds.add(responseId);
  }

  const generation = bytesField(chatModel, 9);
  const generatedAt = generation === undefined ? undefined : bytesField(generation, 4);
  const timestampMs =
    (generatedAt === undefined ? undefined : protobufTimestampMs(generatedAt)) ??
    fallbackTimestampMs;
  const model = normalizeAntigravityModel(stringField(chatModel, 19)?.trim() || "unknown");

  return {
    cacheReadTokens,
    inputTokens,
    model,
    outputTokens,
    reasoningTokens,
    ...(responseId === undefined || responseId.length === 0 ? {} : { responseId }),
    sessionId,
    timestampMs,
    totalTokens: saturatingAdd(inputTokens, cacheReadTokens, outputTokens, reasoningTokens),
  };
}

function normalizeAntigravityModel(model: string): string {
  return ANTIGRAVITY_MODEL_ALIASES[model.toLowerCase()] ?? model;
}

function parseAntigravitySessionTimestamp(blob: Uint8Array): number | undefined {
  const timestamp = bytesField(blob, 2);
  return timestamp === undefined ? undefined : protobufTimestampMs(timestamp);
}

function bytesField(buffer: Uint8Array, target: number): Uint8Array | undefined {
  const reader = new ProtobufReader(buffer);
  for (let next = reader.nextField(); next !== undefined; next = reader.nextField()) {
    if (next.field === target && next.value.kind === "bytes") {
      return next.value.value;
    }
  }

  return undefined;
}

function varintField(buffer: Uint8Array, target: number): bigint | undefined {
  const reader = new ProtobufReader(buffer);
  for (let next = reader.nextField(); next !== undefined; next = reader.nextField()) {
    if (next.field === target && next.value.kind === "varint") {
      return next.value.value;
    }
  }

  return undefined;
}

function stringField(buffer: Uint8Array, target: number): string | undefined {
  const bytes = bytesField(buffer, target);
  if (bytes === undefined) {
    return undefined;
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function protobufTimestampMs(buffer: Uint8Array): number | undefined {
  const seconds = varintField(buffer, 1);
  const nanos = varintField(buffer, 2) ?? 0n;
  if (seconds === undefined || nanos > 999_999_999n) {
    return undefined;
  }

  const milliseconds = seconds * 1000n + nanos / 1_000_000n;
  if (milliseconds <= 0n || milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) {
    return undefined;
  }

  return Number(milliseconds);
}

function tokenCount(value: bigint | undefined): number {
  if (value === undefined) {
    return 0;
  }

  return value > BigInt(MAX_SAFE_TOKEN_COUNT) ? MAX_SAFE_TOKEN_COUNT : Number(value);
}

function saturatingAdd(...values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    if (value >= MAX_SAFE_TOKEN_COUNT - total) {
      return MAX_SAFE_TOKEN_COUNT;
    }
    total += value;
  }

  return total;
}

export { normalizeAntigravityModel, parseAntigravityGeneration, parseAntigravitySessionTimestamp };

export type { AntigravityUsageEvent };

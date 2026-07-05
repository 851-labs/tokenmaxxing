import { createHash } from "node:crypto";

import type { CcusageSessionReport } from "./schema";

/**
 * Privacy scrubbing for `ccusage <source> session --json` payloads before
 * they are uploaded as raw reports. Session entries carry identifiers derived
 * from local project directory paths (claude encodes `~/.claude/projects`
 * directory names into `sessionId`/`projectPath`, codex exposes rollout file
 * names via `sessionFile`), and the privacy policy promises that file paths
 * and project names never leave the machine.
 *
 * The sanitizer is a strict allowlist: only aggregate token counts, costs,
 * date-shaped timestamps, model names, and version strings survive. The
 * session identifier is replaced with a truncated SHA-256 hash so the server
 * can still deduplicate and correlate sessions without learning path-derived
 * names. Every field not on the allowlist is dropped, never passed through.
 */

const SESSION_ID_HASH_LENGTH = 16;

/** Aggregate counters that are safe on sessions and per-model breakdowns. */
const NUMERIC_FIELDS = [
  "cacheCreationTokens",
  "cacheReadTokens",
  "cost",
  "costUSD",
  "inputTokens",
  "outputTokens",
  "totalCost",
  "totalTokens",
] as const;

type NumericField = (typeof NUMERIC_FIELDS)[number];

/** Identifier fields hashed into `sessionId`; first present value wins. */
const SESSION_ID_FIELDS = ["sessionId", "sessionFile"] as const;

/** YYYY-MM-DD with an optional time suffix — anything else could be a path. */
const DATE_LIKE = /^\d{4}-\d{2}-\d{2}([T ][0-9:.TZ+-]*)?$/;

type SanitizedNumericFields = Partial<Record<NumericField, number>>;

interface SanitizedCcusageModelBreakdown extends SanitizedNumericFields {
  modelName: string;
}

interface SanitizedCcusageSession extends SanitizedNumericFields {
  lastActivity?: string;
  modelBreakdowns?: SanitizedCcusageModelBreakdown[];
  modelsUsed?: string[];
  sessionId?: string;
  versions?: string[];
}

interface SanitizedCcusageSessionReport {
  sessions: SanitizedCcusageSession[];
}

function sanitizeSessionReport(report: CcusageSessionReport): SanitizedCcusageSessionReport {
  return {
    sessions: report.sessions.flatMap((session) => {
      const sanitized = sanitizeSession(session);
      return sanitized === undefined ? [] : [sanitized];
    }),
  };
}

function sanitizeSession(session: unknown): SanitizedCcusageSession | undefined {
  if (!isRecord(session)) {
    return undefined;
  }

  const sanitized: SanitizedCcusageSession = pickNumericFields(session);

  const identifier = sessionIdentifier(session);
  if (identifier !== undefined) {
    sanitized.sessionId = hashSessionId(identifier);
  }

  const lastActivity = session["lastActivity"];
  if (typeof lastActivity === "string" && DATE_LIKE.test(lastActivity)) {
    sanitized.lastActivity = lastActivity;
  }

  const modelsUsed = stringArray(session["modelsUsed"]);
  if (modelsUsed !== undefined) {
    sanitized.modelsUsed = modelsUsed;
  }

  const versions = stringArray(session["versions"]);
  if (versions !== undefined) {
    sanitized.versions = versions;
  }

  const modelBreakdowns = sanitizeModelBreakdowns(session["modelBreakdowns"]);
  if (modelBreakdowns !== undefined) {
    sanitized.modelBreakdowns = modelBreakdowns;
  }

  return sanitized;
}

function sanitizeModelBreakdowns(value: unknown): SanitizedCcusageModelBreakdown[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const breakdowns = value.flatMap((entry): SanitizedCcusageModelBreakdown[] => {
    if (!isRecord(entry) || typeof entry["modelName"] !== "string") {
      return [];
    }

    return [{ ...pickNumericFields(entry), modelName: entry["modelName"] }];
  });

  return breakdowns.length === 0 ? undefined : breakdowns;
}

function sessionIdentifier(session: Record<string, unknown>): string | undefined {
  for (const field of SESSION_ID_FIELDS) {
    const value = session[field];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  return undefined;
}

function hashSessionId(identifier: string): string {
  return createHash("sha256").update(identifier).digest("hex").slice(0, SESSION_ID_HASH_LENGTH);
}

function pickNumericFields(record: Record<string, unknown>): SanitizedNumericFields {
  const picked: SanitizedNumericFields = {};
  for (const field of NUMERIC_FIELDS) {
    const value = record[field];
    if (typeof value === "number" && Number.isFinite(value)) {
      picked[field] = value;
    }
  }

  return picked;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const strings = value.filter((entry): entry is string => typeof entry === "string");
  return strings.length === 0 ? undefined : strings;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export { sanitizeSessionReport };

export type {
  SanitizedCcusageModelBreakdown,
  SanitizedCcusageSession,
  SanitizedCcusageSessionReport,
};

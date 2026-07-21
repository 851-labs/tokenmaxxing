import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * API-equivalent cost estimation for sources that record tokens but no
 * cost (antigravity). OpenRouter's public model list carries per-token USD
 * list prices; the table is cached on disk for 24h so the 5-minute service
 * sync doesn't hammer the API. Any failure (offline, API down, unknown
 * model) degrades to cost 0 — tokens still sync.
 */

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const CACHE_FILE = "openrouter-pricing.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

interface OpenRouterPricing {
  /** USD per output token. */
  completion: number;
  /** USD per cached-read input token. */
  inputCacheRead: number;
  /** USD per input token. */
  prompt: number;
}

/** Normalized model id (no provider prefix) -> pricing. */
type PricingTable = Record<string, OpenRouterPricing>;

interface LoadPricingOptions {
  fetchFn?: FetchLike | undefined;
  now?: number | undefined;
}

/** Narrow fetch signature — the DOM typeof fetch carries unrelated statics. */
type FetchLike = (
  input: string | URL,
  init?: { signal?: AbortSignal | undefined },
) => Promise<Response>;

/** "anthropic/claude-sonnet-4.6" and "claude-sonnet-4-6" both -> "claudesonnet46". */
function normalizeModelKey(id: string): string {
  const suffix = id.includes("/") ? (id.split("/").pop() ?? id) : id;
  return suffix.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function matchPricing(table: PricingTable, model: string): OpenRouterPricing | undefined {
  return table[normalizeModelKey(model)];
}

function estimateCost(
  usage: { cacheReadTokens: number; inputTokens: number; outputTokens: number },
  pricing: OpenRouterPricing | undefined,
): number {
  if (pricing === undefined) {
    return 0;
  }

  return (
    usage.inputTokens * pricing.prompt +
    usage.outputTokens * pricing.completion +
    usage.cacheReadTokens * pricing.inputCacheRead
  );
}

interface PricingCacheFile {
  fetchedAt: number;
  prices: PricingTable;
}

/** Fresh cache, else refetch; stale cache beats nothing when fetch fails. */
async function loadOpenRouterPricing(
  cacheDir: string,
  options: LoadPricingOptions = {},
): Promise<PricingTable> {
  const now = options.now ?? Date.now();
  const cached = await readPricingCache(join(cacheDir, CACHE_FILE));
  if (cached !== null && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.prices;
  }

  try {
    const fetchFn = options.fetchFn ?? fetch;
    const response = await fetchFn(OPENROUTER_MODELS_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`openrouter responded ${response.status}`);
    }

    const prices = parseModelsResponse(await response.json());
    await writePricingCache(join(cacheDir, CACHE_FILE), { fetchedAt: now, prices });
    return prices;
  } catch {
    return cached?.prices ?? {};
  }
}

function parseModelsResponse(payload: unknown): PricingTable {
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) {
    return {};
  }

  const prices: PricingTable = {};
  for (const entry of data) {
    const id = (entry as { id?: unknown })?.id;
    const pricing = (entry as { pricing?: unknown })?.pricing;
    if (typeof id !== "string" || pricing === null || typeof pricing !== "object") {
      continue;
    }

    const prompt = parsePrice((pricing as Record<string, unknown>)["prompt"]);
    const completion = parsePrice((pricing as Record<string, unknown>)["completion"]);
    if (prompt === undefined || completion === undefined) {
      continue;
    }

    prices[normalizeModelKey(id)] = {
      completion,
      inputCacheRead: parsePrice((pricing as Record<string, unknown>)["input_cache_read"]) ?? 0,
      prompt,
    };
  }

  return prices;
}

function parsePrice(value: unknown): number | undefined {
  const price = typeof value === "string" ? Number(value) : value;
  return typeof price === "number" && Number.isFinite(price) && price >= 0 ? price : undefined;
}

async function readPricingCache(path: string): Promise<PricingCacheFile | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<PricingCacheFile>;
    if (
      typeof parsed.fetchedAt !== "number" ||
      parsed.prices === null ||
      typeof parsed.prices !== "object"
    ) {
      return null;
    }

    return { fetchedAt: parsed.fetchedAt, prices: parsed.prices as PricingTable };
  } catch {
    return null;
  }
}

async function writePricingCache(path: string, cache: PricingCacheFile): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(cache)}\n`);
  } catch {
    // Cache is best-effort — a read-only config dir must not break sync.
  }
}

export { estimateCost, loadOpenRouterPricing, matchPricing, normalizeModelKey };

export type { LoadPricingOptions, OpenRouterPricing, PricingTable };

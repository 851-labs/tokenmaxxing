/**
 * Local and open-weight runners (llama.cpp, LM Studio, MLX, Ollama) report the
 * file or directory they loaded as the model, so a ccusage model name can be a
 * filesystem path naming the user's home directory. Model names are public
 * (profiles, stats, OG images), so the CLI strips them before upload and the
 * API strips them again at ingest for CLIs released before this existed.
 */

/** Starts like a path (`/`, `~/`, `./`, `../`, `C:\`, `C:/`, `\\`) or contains a backslash. */
const LOCAL_PATH = /^(?:[\\/]|~[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/])|\\/;

/** `/home/<user>`, `/Users/<user>`, `\Users\<user>` or `/root/` anywhere in the name. */
const HOME_SEGMENT = /[\\/](?:home|users)[\\/][^\\/]+(?:[\\/]|$)|[\\/]root(?:[\\/]|$)/i;

const HOME_PARENT = /^(?:home|users)$/i;

const DRIVE = /^[A-Za-z]:$/;

/** One Hugging Face hub cache repo directory: `models--<org>--<repo>`. */
const HF_CACHE_REPO = /^models--(.+)$/;

interface ModelTokenCounts {
  readonly cacheCreationTokens?: number | undefined;
  readonly cacheReadTokens?: number | undefined;
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly totalTokens?: number | undefined;
}

/** The model-name fields of a ccusage daily report day, in all its dialects. */
interface CcusageDayModels {
  readonly modelBreakdowns?: ReadonlyArray<{ readonly modelName: string }> | undefined;
  readonly models?: { readonly [model: string]: ModelTokenCounts } | undefined;
  readonly modelsUsed?: ReadonlyArray<string> | undefined;
}

/**
 * A name that is unambiguously a path keeps only its last segment: it starts
 * with `/`, `~/`, `./`, `../`, a drive letter, `\\` or `file:`, contains a
 * backslash, or contains a home-directory segment anywhere. Provider ids with
 * slashes (`openai/gpt-5`, `~anthropic/claude-…`, `openrouter/qwen/…`) are not
 * paths and pass through unchanged.
 *
 * A Hugging Face cache path (`…/models--<org>--<repo>/snapshots/<sha>/<file>`)
 * keeps the file name like any other path, so the same weights get the same
 * name wherever they were downloaded to; a path that stops at the snapshot
 * directory becomes `<org>/<repo>`, since its last segment is a commit sha.
 *
 * ccusage prices each model on the device from its original name, so
 * stripping never changes cost.
 */
function stripModelPath(model: string): string {
  const trimmed = model.trim();
  const path = trimmed.replace(/^file:/i, "");
  if (path === trimmed && !LOCAL_PATH.test(path) && !HOME_SEGMENT.test(path)) {
    return model;
  }

  const segments = path
    .split(/[\\/]+/)
    .filter((segment) => segment !== "" && segment !== "." && segment !== "..");
  const hfRepoIndex = segments.findIndex(
    (segment, index) => HF_CACHE_REPO.test(segment) && segments[index + 1] === "snapshots",
  );
  if (hfRepoIndex !== -1 && segments.length <= hfRepoIndex + 3) {
    return HF_CACHE_REPO.exec(segments[hfRepoIndex]!)![1]!.split("--").join("/");
  }

  const last = segments.at(-1);
  // A path that is only a drive or a home directory has no model name in it,
  // and its last segment would be the user name.
  if (last === undefined || DRIVE.test(last) || HOME_PARENT.test(segments.at(-2) ?? "")) {
    return "unknown";
  }
  return last;
}

/**
 * Strips paths from every model name in a ccusage day. Paths that strip to
 * the same name are merged: `modelsUsed` is deduplicated and `models` entries
 * are summed; `modelBreakdowns` may repeat a name, which aggregation sums.
 */
function stripDayModelPaths<Day extends CcusageDayModels>(day: Day): Day {
  const stripped: { -readonly [K in keyof CcusageDayModels]: CcusageDayModels[K] } = {};
  if (day.modelBreakdowns !== undefined) {
    stripped.modelBreakdowns = day.modelBreakdowns.map((breakdown) => ({
      ...breakdown,
      modelName: stripModelPath(breakdown.modelName),
    }));
  }
  if (day.modelsUsed !== undefined) {
    stripped.modelsUsed = [...new Set(day.modelsUsed.map(stripModelPath))];
  }
  if (day.models !== undefined) {
    const models: Record<string, ModelTokenCounts> = {};
    for (const [model, entry] of Object.entries(day.models)) {
      const name = stripModelPath(model);
      const existing = models[name];
      models[name] = existing === undefined ? entry : sumModelTokenCounts(existing, entry);
    }
    stripped.models = models;
  }

  return { ...day, ...stripped };
}

function sumModelTokenCounts(left: ModelTokenCounts, right: ModelTokenCounts): ModelTokenCounts {
  const sum: { -readonly [K in keyof ModelTokenCounts]: ModelTokenCounts[K] } = {};
  for (const key of [
    "cacheCreationTokens",
    "cacheReadTokens",
    "inputTokens",
    "outputTokens",
    "totalTokens",
  ] as const) {
    if (left[key] !== undefined || right[key] !== undefined) {
      sum[key] = (left[key] ?? 0) + (right[key] ?? 0);
    }
  }

  return sum;
}

export { stripDayModelPaths, stripModelPath };

export type { CcusageDayModels, ModelTokenCounts };

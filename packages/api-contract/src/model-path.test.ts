import { describe, expect, it } from "vite-plus/test";

import { stripDayModelPaths, stripModelPath } from "./model-path";

describe("stripModelPath", () => {
  it.each([
    // The five path shapes seen in production, with synthetic user names.
    [
      "/home/alice/Downloads/gemma-4-12B-it-qat-UD-Q4_K_XL.gguf",
      "gemma-4-12B-it-qat-UD-Q4_K_XL.gguf",
    ],
    [
      "/home/alice/models/qwen36-fable711/Qwen3.6-27B-Fable-Fus-711-UnHeretic-NM-DAU-NEO-MAX-NEO-MTP-Q4_K_S.gguf",
      "Qwen3.6-27B-Fable-Fus-711-UnHeretic-NM-DAU-NEO-MAX-NEO-MTP-Q4_K_S.gguf",
    ],
    [
      "/home/alice/.cache/huggingface/hub/models--noctrex--LFM2.5-2.6B-heretic-uncensored-GGUF/snapshots/0123456789abcdef0123456789abcdef01234567/LFM2.5-2.6B-heretic-uncensored-Q4_K_M.gguf",
      "LFM2.5-2.6B-heretic-uncensored-Q4_K_M.gguf",
    ],
    [
      "/root/Bonsai-demo/models/bonsai2-gguf/27B/Ternary-Bonsai-2-27B-PTQ1_0.gguf",
      "Ternary-Bonsai-2-27B-PTQ1_0.gguf",
    ],
    ["/Users/alice/maple-mlx/maple-2bit-mlx", "maple-2bit-mlx"],
    // Other path shapes.
    ["/Users/alice/maple-mlx/maple-2bit-mlx/", "maple-2bit-mlx"],
    ["/opt/models/llama-3.1-8b.gguf", "llama-3.1-8b.gguf"],
    ["~/models/llama-3.1-8b.gguf", "llama-3.1-8b.gguf"],
    ["~\\models\\llama-3.1-8b.gguf", "llama-3.1-8b.gguf"],
    ["./models/llama-3.1-8b.gguf", "llama-3.1-8b.gguf"],
    ["../llama-3.1-8b.gguf", "llama-3.1-8b.gguf"],
    ["C:\\Users\\alice\\models\\llama-3.1-8b.gguf", "llama-3.1-8b.gguf"],
    ["c:/Users/alice/models/llama-3.1-8b.gguf", "llama-3.1-8b.gguf"],
    ["D:\\AI\\LM Studio\\llama-3.1-8b.gguf", "llama-3.1-8b.gguf"],
    ["\\\\nas\\models\\llama-3.1-8b.gguf", "llama-3.1-8b.gguf"],
    ["models\\llama-3.1-8b.gguf", "llama-3.1-8b.gguf"],
    ["file:///home/alice/models/llama-3.1-8b.gguf", "llama-3.1-8b.gguf"],
    ["file:///C:/Users/alice/llama-3.1-8b.gguf", "llama-3.1-8b.gguf"],
    ["FILE://nas/models/llama-3.1-8b.gguf", "llama-3.1-8b.gguf"],
    ["  /home/alice/models/llama-3.1-8b.gguf  ", "llama-3.1-8b.gguf"],
    // A Hugging Face snapshot directory names the repo, not a file.
    [
      "/Users/alice/.cache/huggingface/hub/models--mlx-community--Qwen3-4B-4bit/snapshots/0123456789abcdef0123456789abcdef01234567",
      "mlx-community/Qwen3-4B-4bit",
    ],
    ["~/.cache/huggingface/hub/models--gpt2/snapshots/abc123/", "gpt2"],
    // A home-directory segment anywhere is a path, whatever comes before it.
    ["llama.cpp:/home/alice/models/llama-3.1-8b.gguf", "llama-3.1-8b.gguf"],
    ["[preview] /Users/alice/models/llama-3.1-8b.gguf", "llama-3.1-8b.gguf"],
    ["openrouter//home/alice/llama-3.1-8b.gguf", "llama-3.1-8b.gguf"],
    // A bare home directory or drive has no model name, only the user name.
    ["/home/alice", "unknown"],
    ["/Users/alice/", "unknown"],
    ["C:\\Users\\alice", "unknown"],
    ["C:\\", "unknown"],
    ["/", "unknown"],
  ])("strips path %s to %s", (model, expected) => {
    expect(stripModelPath(model)).toBe(expected);
    expect(stripModelPath(expected)).toBe(expected);
  });

  it.each([
    "gpt-5.5",
    "claude-opus-4-5-20251101",
    "openai/gpt-5",
    "z-ai/glm-5",
    "Qwen/Qwen3-Coder-480B-A35B-Instruct",
    "qwen/qwen3-coder",
    "meta/llama-4-maverick",
    "google/gemini-2.5-pro",
    "xai/grok-4",
    "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    "openrouter/anthropic/claude-sonnet-4.5",
    "openrouter/qwen/qwen3-coder:free",
    "~google/gemini-2.5-pro",
    "~anthropic/claude-sonnet-4.5",
    "route/claude-sonnet-4-5",
    "lmstudio-community/Qwen3-4B-GGUF/Qwen3-4B-Q4_K_M.gguf",
    "hf.co/unsloth/Qwen3-4B-GGUF:Q4_K_M",
    "llama3.1:8b",
    "accounts/fireworks/models/kimi-k2-instruct",
    "[preview] gpt-5.5",
    "unknown",
  ])("keeps provider id %s", (model) => {
    expect(stripModelPath(model)).toBe(model);
  });
});

describe("stripDayModelPaths", () => {
  it("strips every dialect's model names and merges paths that strip to one name", () => {
    expect(
      stripDayModelPaths({
        date: "2026-09-21",
        modelBreakdowns: [
          { inputTokens: 1, modelName: "/home/alice/a/gemma.gguf" },
          { inputTokens: 2, modelName: "openai/gpt-5" },
        ],
        models: {
          "/Users/alice/maple-mlx/maple-2bit-mlx": { inputTokens: 5, totalTokens: 5 },
          "/Users/alice/old/maple-2bit-mlx": { outputTokens: 7, totalTokens: 7 },
          "~anthropic/claude-sonnet-4.5": { inputTokens: 1 },
        },
        modelsUsed: ["/home/alice/a/gemma.gguf", "/home/alice/b/gemma.gguf", "openai/gpt-5"],
        totalTokens: 15,
      }),
    ).toEqual({
      date: "2026-09-21",
      modelBreakdowns: [
        { inputTokens: 1, modelName: "gemma.gguf" },
        { inputTokens: 2, modelName: "openai/gpt-5" },
      ],
      models: {
        "maple-2bit-mlx": { inputTokens: 5, outputTokens: 7, totalTokens: 12 },
        "~anthropic/claude-sonnet-4.5": { inputTokens: 1 },
      },
      modelsUsed: ["gemma.gguf", "openai/gpt-5"],
      totalTokens: 15,
    });
  });

  it("leaves a day without model fields as it was", () => {
    const day: { date: string; modelsUsed?: string[]; totalTokens: number } = {
      date: "2026-09-21",
      totalTokens: 3,
    };

    expect(stripDayModelPaths(day)).toEqual({ date: "2026-09-21", totalTokens: 3 });
  });
});

import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_SOURCE_NAMES } from "../../../cli/src/ccusage/sources";
import { buildLlmsTxt } from "../routes/llms[.]txt";
import { SUPPORTED_AGENTS, supportedAgentSentenceList } from "./agents";

describe("supported agents", () => {
  it("lists exactly the sources the CLI syncs", () => {
    expect(SUPPORTED_AGENTS.map((agent) => agent.source)).toEqual(DEFAULT_SOURCE_NAMES);
  });

  it("joins labels for prose", () => {
    expect(supportedAgentSentenceList()).toBe(
      "Claude Code, OpenAI Codex, OpenCode, Gemini CLI, GitHub Copilot CLI, Hermes Agent, and Pi",
    );
  });

  it("keeps llms.txt in sync with the same list", () => {
    const llms = buildLlmsTxt();

    for (const agent of SUPPORTED_AGENTS) {
      expect(llms).toContain(`- ${agent.label}\n`);
    }
    expect(llms).not.toContain("Cursor");
  });
});

import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_SOURCE_NAMES } from "../../../cli/src/ccusage/sources";
import { buildLlmsTxt } from "../routes/llms[.]txt";
import { agentLabel, SUPPORTED_AGENTS, supportedAgentSentenceList } from "./agents";

describe("supported agents", () => {
  it("lists exactly the sources the CLI syncs", () => {
    expect(SUPPORTED_AGENTS.map((agent) => agent.source)).toEqual(DEFAULT_SOURCE_NAMES);
  });

  it("joins labels for prose", () => {
    expect(supportedAgentSentenceList()).toBe(
      "Claude Code, OpenAI Codex, OpenCode, Gemini CLI, GitHub Copilot CLI, Hermes Agent, Pi, " +
        "Grok Build CLI, Antigravity, ZCode, Amp, Qwen Code, Kimi CLI, Kilo Code, Goose, Droid, " +
        "Codebuff, and OpenClaw",
    );
  });

  it("counts the agents past a limit", () => {
    expect(supportedAgentSentenceList({ limit: 4 })).toBe(
      "Claude Code, OpenAI Codex, OpenCode, Gemini CLI, and 14 more agents",
    );
    expect(supportedAgentSentenceList({ limit: SUPPORTED_AGENTS.length })).toBe(
      supportedAgentSentenceList(),
    );
  });

  it("labels stored sources and passes unknown ones through", () => {
    expect(agentLabel("grok")).toBe("Grok Build CLI");
    expect(agentLabel("zcode")).toBe("ZCode");
    expect(agentLabel("cursor")).toBe("cursor");
  });

  it("keeps llms.txt in sync with the same list", () => {
    const llms = buildLlmsTxt();

    for (const agent of SUPPORTED_AGENTS) {
      expect(llms).toContain(`- ${agent.label}\n`);
    }
    expect(llms).not.toContain("Cursor");
  });
});

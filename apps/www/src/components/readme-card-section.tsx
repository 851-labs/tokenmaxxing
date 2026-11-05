import { Check, Copy, GithubLogo } from "@phosphor-icons/react/ssr";
import { useState } from "react";

import { useCopyToClipboard } from "../hooks/use-copy-to-clipboard";
import { cn } from "../lib/cn";
import { README_CARD_WIDTH } from "../lib/readme-card";
import type { ReadmeCardLayout, ReadmeCardTheme } from "../lib/readme-card";
import { readmeCardPath, readmeCardSnippet } from "../lib/readme-card-embed";
import type { ReadmeCardEmbedFormat } from "../lib/readme-card-embed";
import { Button } from "./ui/button";
import { codeTextStyle } from "./ui/code";
import { SegmentedControl } from "./ui/segmented-control";

type SpendVisibility = "hide" | "show";

const CARD_THEME_OPTIONS = [
  { label: "Auto", value: "auto" },
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
] as const;

const CARD_LAYOUT_OPTIONS = [
  { label: "Full", value: "full" },
  { label: "Compact", value: "compact" },
] as const;

const CARD_SPEND_OPTIONS = [
  { label: "Show", value: "show" },
  { label: "Hide", value: "hide" },
] as const;

const CARD_FORMAT_OPTIONS = [
  { label: "Markdown", value: "markdown" },
  { label: "HTML", value: "html" },
] as const;

/** Settings section: a live preview of the README card plus a copyable embed snippet. */
function ReadmeCardSection({ login }: { login: string }) {
  const [theme, setTheme] = useState<ReadmeCardTheme>("auto");
  const [layout, setLayout] = useState<ReadmeCardLayout>("full");
  const [spend, setSpend] = useState<SpendVisibility>("show");
  const [format, setFormat] = useState<ReadmeCardEmbedFormat>("markdown");
  const { copiedKey, copy } = useCopyToClipboard<"snippet">();
  const options = { hideSpend: spend === "hide", layout, theme };
  const snippet = readmeCardSnippet(login, options, format);
  const src = readmeCardPath(login, options);
  // Keep showing the last loaded card until the new one arrives, so toggles don't blank it.
  const [shownSrc, setShownSrc] = useState(src);
  const loading = src !== shownSrc;

  return (
    <section aria-labelledby="settings-readme-card-title">
      <h2 className="flex items-center gap-2 text-lg font-medium" id="settings-readme-card-title">
        <GithubLogo aria-hidden="true" className="size-4" /> README card
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Show your stats on your GitHub profile: paste the snippet into your profile README. GitHub
        refreshes the image about every 30 minutes. Auto follows each viewer's system theme.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3 text-sm">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">Theme</span>
          <SegmentedControl
            label="Card theme"
            onChange={setTheme}
            options={CARD_THEME_OPTIONS}
            value={theme}
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">Size</span>
          <SegmentedControl
            label="Card size"
            onChange={setLayout}
            options={CARD_LAYOUT_OPTIONS}
            value={layout}
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">Spend</span>
          <SegmentedControl
            label="Show spend on the card"
            onChange={setSpend}
            options={CARD_SPEND_OPTIONS}
            value={spend}
          />
        </div>
      </div>
      <div className="-mx-4 mt-4 overflow-x-auto border-y border-border bg-muted/40 p-4">
        <img
          alt={`Preview of ${login}'s README card`}
          className={cn("block h-auto max-w-full transition-opacity", loading && "opacity-60")}
          src={shownSrc}
          width={README_CARD_WIDTH}
        />
        {loading ? (
          <img
            alt=""
            aria-hidden="true"
            className="hidden"
            onError={() => setShownSrc(src)}
            onLoad={() => setShownSrc(src)}
            src={src}
          />
        ) : null}
      </div>
      <div className="mt-4 border border-border">
        <div className="flex items-center justify-between gap-3 border-b border-border p-1.5">
          <SegmentedControl
            label="Snippet format"
            onChange={setFormat}
            options={CARD_FORMAT_OPTIONS}
            value={format}
          />
          <Button onClick={() => void copy(snippet, "snippet")} size="xs" variant="outline">
            {copiedKey === "snippet" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            {copiedKey === "snippet" ? "Copied" : "Copy"}
          </Button>
        </div>
        <code
          className="block whitespace-pre-wrap p-4 font-mono text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]"
          style={codeTextStyle}
        >
          {snippet}
        </code>
      </div>
    </section>
  );
}

export { ReadmeCardSection };

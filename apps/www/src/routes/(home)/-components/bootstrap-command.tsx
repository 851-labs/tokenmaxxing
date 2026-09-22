import { Tabs } from "@base-ui/react/tabs";
import { Check, Copy } from "@phosphor-icons/react/ssr";
import { useState } from "react";

import { useCopyToClipboard } from "../../../hooks/use-copy-to-clipboard";
import { cn } from "../../../lib/cn";
import { NPM_INSTALL_COMMAND, NPM_PACKAGE } from "../../../lib/site";
import { codeTextStyle } from "../../../components/ui/code";

const BOOTSTRAP_COMMANDS = [
  { command: `${NPM_INSTALL_COMMAND}\ntokenmaxxing bootstrap`, label: "npm", value: "npm" },
  {
    command: `bun add -g --trust ${NPM_PACKAGE}@latest\ntokenmaxxing bootstrap`,
    label: "bun",
    value: "bun",
  },
  {
    command: `pnpm add -g ${NPM_PACKAGE}@latest\ntokenmaxxing bootstrap`,
    label: "pnpm",
    value: "pnpm",
  },
] as const;

type BootstrapPackageManager = (typeof BOOTSTRAP_COMMANDS)[number]["value"];

/** Package-manager tabs over a click-to-copy install + bootstrap command. */
function BootstrapCommand() {
  const [packageManager, setPackageManager] = useState<BootstrapPackageManager>("npm");
  const { copiedKey, copy } = useCopyToClipboard<BootstrapPackageManager>();

  return (
    <Tabs.Root
      className="overflow-hidden border border-border bg-muted/40"
      onValueChange={(next) => setPackageManager(next as BootstrapPackageManager)}
      value={packageManager}
    >
      <Tabs.List className="relative flex border-b border-border" aria-label="Package manager">
        <Tabs.Indicator
          className="absolute bottom-0 left-[calc(var(--active-tab-left)+1rem)] z-0 h-0.5 w-[calc(var(--active-tab-width)-2rem)] bg-foreground transition-all duration-200 ease-out"
          renderBeforeHydration
        />
        {BOOTSTRAP_COMMANDS.map((option) => (
          <Tabs.Tab
            className={cn(
              "relative z-10 px-4 py-2.5 font-mono text-sm transition-colors",
              "text-muted-foreground hover:text-foreground",
              "data-active:text-foreground",
            )}
            key={option.value}
            value={option.value}
          >
            {option.label}
          </Tabs.Tab>
        ))}
      </Tabs.List>
      {BOOTSTRAP_COMMANDS.map((option) => (
        // The copy button inside is the panel's focus target; skip the panel itself.
        <Tabs.Panel key={option.value} tabIndex={-1} value={option.value}>
          <button
            aria-label={`Copy ${option.label} bootstrap command`}
            className="group flex w-full items-start justify-between gap-4 bg-transparent p-4 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-accent"
            onClick={() => void copy(option.command, option.value)}
            type="button"
          >
            <code
              className="min-w-0 overflow-x-auto whitespace-pre font-mono text-sm leading-6 text-muted-foreground"
              style={codeTextStyle}
            >
              {option.command}
            </code>
            <span className="mt-0.5 shrink-0 text-muted-foreground opacity-100 transition-opacity group-hover:text-foreground sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-visible:opacity-100">
              {copiedKey === option.value ? (
                <Check className="size-4" />
              ) : (
                <Copy className="size-4" />
              )}
            </span>
          </button>
        </Tabs.Panel>
      ))}
    </Tabs.Root>
  );
}

export { BootstrapCommand };

import { useState } from "react";
import NumberFlow from "@number-flow/react";

import { useHydrated } from "../hooks/use-hydrated";
import { cn } from "../lib/cn";
import {
  formatInteger,
  formatTokens,
  formatUsd,
  integerDisplay,
  tokensDisplay,
  usdDisplay,
  type NumberDisplay,
} from "../lib/format";

/**
 * Values that animate when they change, like SwiftUI's numeric text
 * transition: numbers roll digit by digit (NumberFlow), text fades in. The
 * first render never animates, so SSR and hydration paint the value as-is,
 * and both honor `prefers-reduced-motion`.
 *
 * NumberFlow can't render on the server here: it picks its SSR markup with
 * `esm-env`, which resolves the `browser` export condition the Workers build
 * sets, so it would send an empty element. Numbers therefore render as their
 * formatted text until hydration, then hand over to NumberFlow.
 */

const NUMBER_KINDS = {
  integer: { display: integerDisplay, format: formatInteger },
  tokens: { display: tokensDisplay, format: formatTokens },
  usd: { display: usdDisplay, format: formatUsd },
} as const satisfies Record<
  string,
  { display: (value: number) => NumberDisplay | null; format: (value: number) => string }
>;

type NumberKind = keyof typeof NUMBER_KINDS;

/** A number in one of the shared formats; caps and dashes render as plain text. */
function AnimatedNumber({ kind, value }: { kind: NumberKind; value: number }) {
  const hydrated = useHydrated();
  const { display, format } = NUMBER_KINDS[kind];
  const spec = display(value);
  if (!hydrated || spec === null) {
    return format(value);
  }

  return (
    <NumberFlow
      format={spec.format}
      locales="en-US"
      prefix={spec.prefix}
      suffix={spec.suffix}
      value={spec.value}
    />
  );
}

/** Text that fades in when it changes, but not on first paint. */
function AnimatedText({ className, text }: { className?: string; text: string }) {
  const [previous, setPrevious] = useState(text);
  const [changed, setChanged] = useState(false);
  if (text !== previous) {
    setPrevious(text);
    setChanged(true);
  }

  return (
    <span className={cn(changed && "motion-safe:animate-value-swap", className)} key={text}>
      {text}
    </span>
  );
}

export { AnimatedNumber, AnimatedText };

export type { NumberKind };

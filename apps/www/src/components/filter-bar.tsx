import type { ReactNode } from "react";

import { cn } from "../lib/cn";

/**
 * A page's filters, pinned under the site header (`h-14`) while the sections
 * they filter scroll by: put it first inside a wrapper around exactly those
 * sections, since a sticky element only stays pinned within its parent. The
 * span on the left names what the filters currently cover. Marked as sticky
 * chrome, so chart tooltips never slide underneath it.
 */
function FilterBar({
  children,
  hideSpanWhenNarrow = false,
  span,
}: {
  children: ReactNode;
  /** Drop the span on phones, where several controls already wrap the bar onto two rows. */
  hideSpanWhenNarrow?: boolean;
  span: ReactNode;
}) {
  return (
    <div
      className="sticky top-14 z-40 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-y border-border bg-background/80 px-4 py-2 backdrop-blur"
      data-sticky-chrome=""
    >
      <p
        className={cn(
          "text-sm tabular-nums text-muted-foreground",
          hideSpanWhenNarrow && "max-sm:hidden",
        )}
      >
        {span}
      </p>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

export { FilterBar };

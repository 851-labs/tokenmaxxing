import type { ReactNode } from "react";

import { cn } from "../../lib/cn";

/** An inline failure message, announced to assistive tech as it appears. */
function ErrorText({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn("text-sm text-red-500", className)} role="alert">
      {children}
    </p>
  );
}

export { ErrorText };

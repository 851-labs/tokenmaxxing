import type { ReactNode } from "react";

/** Inline link to another site, styled for use inside muted body copy. */
function ExternalLink({ children, href }: { children: ReactNode; href: string }) {
  return (
    <a
      className="font-medium text-foreground hover:underline"
      href={href}
      rel="noreferrer"
      target="_blank"
    >
      {children}
    </a>
  );
}

export { ExternalLink };

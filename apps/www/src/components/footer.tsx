import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";

import { formatCompact } from "../lib/format";
import { githubStarsQueryOptions } from "../lib/github-stars";
import { CHANGELOG_URL, DISCORD_URL, GITHUB_URL, X_URL } from "../lib/site";

/** Footer cells split by hairlines, with page breathing room after the footer. */
function Footer() {
  // Resolved server-side by the root loader; null when GitHub was unavailable.
  const stars = useQuery(githubStarsQueryOptions);

  return (
    <footer className="mx-4 mb-16 max-w-5xl border-x border-border lg:mx-auto -mt-px grid grid-cols-2 gap-px border-y bg-border font-mono sm:grid-cols-4">
      <FooterLink href={GITHUB_URL}>
        GitHub
        {stars.data === undefined || stars.data === null ? null : (
          <span className="text-muted-foreground">[{formatCompact(stars.data)}]</span>
        )}
      </FooterLink>
      <FooterLink href={CHANGELOG_URL}>Changelog</FooterLink>
      <FooterLink href={DISCORD_URL}>Discord</FooterLink>
      <FooterLink href={X_URL}>X</FooterLink>
    </footer>
  );
}

function FooterLink({ children, href }: { children: ReactNode; href: string }) {
  return (
    <a
      className="flex items-center justify-center gap-1.5 bg-background py-6 text-sm text-muted-foreground transition-colors hover:text-foreground hover:underline"
      href={href}
      rel="noreferrer"
      target="_blank"
    >
      {children}
    </a>
  );
}

export { Footer };

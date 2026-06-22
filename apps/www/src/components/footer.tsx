import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

const GITHUB_REPO = "851-labs/tokenmaxxing";
const GITHUB_URL = `https://github.com/${GITHUB_REPO}`;

const LINKS = {
  changelog: `${GITHUB_URL}/blob/main/CHANGELOG.md`,
  discord: "https://discord.gg/WzX6BpfaRH",
  x: "https://x.com/pondorasti",
};

const starsFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  notation: "compact",
});

/** Live GitHub star count for the badge. Unauthenticated, cached for an hour;
 * on failure the count is simply omitted. */
function useGithubStars() {
  return useQuery({
    queryFn: async (): Promise<number> => {
      const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}`);
      if (!response.ok) {
        throw new Error(`GitHub API responded ${response.status}`);
      }
      const data = (await response.json()) as { stargazers_count: number };
      return data.stargazers_count;
    },
    queryKey: ["github-stars", GITHUB_REPO],
    staleTime: 1000 * 60 * 60,
  });
}

/** Footer cells split by hairlines, with page breathing room after the footer. */
function Footer() {
  const stars = useGithubStars();

  return (
    <footer className="mx-4 mb-16 max-w-5xl border-x border-border lg:mx-auto -mt-px grid grid-cols-3 gap-px border-y bg-border font-mono sm:grid-cols-6">
      <FooterLink href={GITHUB_URL}>
        GitHub
        {stars.data === undefined ? null : (
          <span className="text-muted-foreground">[{starsFormatter.format(stars.data)}]</span>
        )}
      </FooterLink>
      <FooterLink href={LINKS.changelog}>Changelog</FooterLink>
      <FooterLink href={LINKS.discord}>Discord</FooterLink>
      <FooterLink href={LINKS.x}>X</FooterLink>
      <FooterInternalLink to="/privacy">Privacy</FooterInternalLink>
      <FooterInternalLink to="/terms">Terms</FooterInternalLink>
    </footer>
  );
}

const footerCellClassName =
  "flex items-center justify-center gap-1.5 bg-background py-6 text-sm text-muted-foreground transition-colors hover:text-foreground hover:underline";

function FooterLink({ children, href }: { children: ReactNode; href: string }) {
  return (
    <a className={footerCellClassName} href={href} rel="noreferrer" target="_blank">
      {children}
    </a>
  );
}

/** Same-origin, crawlable footer link (no target=_blank). */
function FooterInternalLink({ children, to }: { children: ReactNode; to: string }) {
  return (
    <Link className={footerCellClassName} to={to}>
      {children}
    </Link>
  );
}

export { Footer };

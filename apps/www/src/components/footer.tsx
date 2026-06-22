import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";

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
    gcTime: 1000 * 60 * 60 * 24,
    refetchOnWindowFocus: false,
  });
}

/** Footer cells split by hairlines, with page breathing room after the footer. */
function Footer() {
  const stars = useGithubStars();

  return (
    <footer className="mx-4 mb-16 max-w-5xl border-x border-border lg:mx-auto -mt-px grid grid-cols-2 gap-px border-y bg-border font-mono sm:grid-cols-4">
      <FooterLink href={GITHUB_URL}>
        GitHub
        {/* Reserve a fixed-width slot so the badge never shifts layout when it loads. */}
        <span className="inline-block w-10 text-left text-muted-foreground">
          {stars.data === undefined ? null : `[${starsFormatter.format(stars.data)}]`}
        </span>
      </FooterLink>
      <FooterLink href={LINKS.changelog}>Changelog</FooterLink>
      <FooterLink href={LINKS.discord}>Discord</FooterLink>
      <FooterLink href={LINKS.x}>X</FooterLink>
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

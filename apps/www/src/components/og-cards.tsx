import type { ReactNode } from "react";

import { supportedAgentSentenceList } from "../lib/agents";
import { formatInteger, formatTokens, formatUsd } from "../lib/format";
import type { ProfileOgData } from "../lib/og-data";
import { NPM_INSTALL_COMMAND, SITE_DESCRIPTION, SITE_NAME } from "../lib/site";

/**
 * 1200×630 HTML cards captured into Open Graph PNGs. Values use the same
 * formatters as the profile page, so a shared card matches what it links to.
 */

/** The fixed hairline frame and site header shared by every card. */
function OgCardFrame({ children }: { children: ReactNode }) {
  return (
    <div
      className="relative h-157.5 w-300 overflow-hidden bg-background text-foreground"
      data-og-card
      id="og-card"
    >
      <div aria-hidden="true" className="absolute bottom-0 left-14 top-0 z-10 w-px bg-border" />
      <div aria-hidden="true" className="absolute bottom-0 right-14 top-0 z-10 w-px bg-border" />
      <div aria-hidden="true" className="absolute left-0 right-0 top-15 h-px bg-border" />
      <div aria-hidden="true" className="absolute left-14 right-14 top-50 h-px bg-border" />
      <div aria-hidden="true" className="absolute left-0 right-0 top-142.75 h-px bg-border" />
      <div className="mx-14 flex h-full flex-col">
        <header className="flex h-15 shrink-0 items-center px-6">
          <p className="text-3xl font-semibold">{SITE_NAME}</p>
        </header>
        {children}
      </div>
    </div>
  );
}

function ProfileOgCard({ data }: { data: ProfileOgData }) {
  const { profile } = data;
  const { stats } = profile;
  const metrics = [
    { label: "Total spend", value: formatUsd(stats.totalSpendUsd) },
    { label: "Total tokens", value: formatTokens(stats.totalTokens) },
    { label: "Active days", value: formatInteger(stats.activeDays) },
    { label: "Current streak", value: formatInteger(stats.currentStreakDays) },
    { label: "Sessions", value: formatInteger(stats.sessionCount) },
    { label: "Top spend model", value: stats.topModel === null ? "—" : stats.topModel.model },
  ];

  return (
    <OgCardFrame>
      <header className="flex h-35 shrink-0 items-center gap-7 px-6">
        <div className="flex min-w-0 items-center gap-5">
          {profile.user.avatarUrl === null ? (
            <div className="h-18 w-18 shrink-0 border border-border bg-muted" />
          ) : (
            <img
              alt=""
              className="h-18 w-18 shrink-0 border border-border object-cover"
              src={profile.user.avatarUrl}
            />
          )}
          <div className="min-w-0">
            <h1 className="truncate text-5xl font-semibold tracking-normal">
              {profile.user.login}
            </h1>
          </div>
        </div>
      </header>
      <section className="grid h-92.75 shrink-0 grid-cols-3 grid-rows-[185px_185px] gap-px bg-border">
        {metrics.map((metric) => (
          <div className="flex flex-col justify-center bg-background px-9" key={metric.label}>
            <p className="font-mono text-2xl uppercase text-muted-foreground">{metric.label}</p>
            <p className="mt-5 truncate text-5xl font-semibold tracking-normal">{metric.value}</p>
          </div>
        ))}
      </section>
    </OgCardFrame>
  );
}

/** The default card for pages without their own image. */
function SiteOgCard() {
  return (
    <OgCardFrame>
      <header className="flex h-35 shrink-0 items-center px-6">
        <h1 className="text-5xl font-semibold tracking-normal">
          {SITE_DESCRIPTION.replace(/\.$/, "")}
        </h1>
      </header>
      <section className="flex h-92.75 shrink-0 flex-col justify-center gap-8 px-9">
        <div>
          <p className="font-mono text-2xl uppercase text-muted-foreground">Get started</p>
          <p className="mt-5 font-mono text-3xl">{NPM_INSTALL_COMMAND}</p>
          <p className="mt-3 font-mono text-3xl">tokenmaxxing bootstrap</p>
        </div>
        <p className="text-2xl leading-snug text-muted-foreground">
          Leaderboards for {supportedAgentSentenceList()} usage.
        </p>
      </section>
    </OgCardFrame>
  );
}

export { OgCardFrame, ProfileOgCard, SiteOgCard };

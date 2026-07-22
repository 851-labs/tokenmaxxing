import { createFileRoute, notFound } from "@tanstack/react-router";

import { formatOgNumber, formatOgTokens, formatOgUsd } from "../../lib/og";
import { loadProfileOgData, type ProfileOgData } from "../../lib/og-data";

const Route = createFileRoute("/og-card/$login")({
  loader: async ({ params }) => {
    const data = await loadProfileOgData(params.login);
    if (data === null) {
      throw notFound();
    }

    return {
      data,
    };
  },
  head: () => ({
    meta: [{ content: "noindex", name: "robots" }],
  }),
  component: OgCardPage,
});

function OgCardPage() {
  const { data } = Route.useLoaderData();

  return <ProfileOgCard data={data} />;
}

function ProfileOgCard({ data }: { data: ProfileOgData }) {
  return (
    <div
      className="relative h-[630px] w-[1200px] overflow-hidden bg-background text-foreground"
      data-og-card
      id="og-card"
    >
      <div aria-hidden="true" className="absolute bottom-0 left-14 top-0 z-10 w-px bg-border" />
      <div aria-hidden="true" className="absolute bottom-0 right-14 top-0 z-10 w-px bg-border" />
      <div aria-hidden="true" className="absolute left-0 right-0 top-[60px] h-px bg-border" />
      <div aria-hidden="true" className="absolute left-14 right-14 top-[200px] h-px bg-border" />
      <div aria-hidden="true" className="absolute left-0 right-0 top-[571px] h-px bg-border" />
      <div className="mx-14 flex h-full flex-col">
        <header className="flex h-[60px] shrink-0 items-center px-6">
          <p className="text-3xl font-semibold">tokenmaxxing.sh</p>
        </header>
        <OgProfileHeader data={data} />
        <StatsGrid data={data} />
      </div>
    </div>
  );
}

function OgProfileHeader({ data }: { data: ProfileOgData }) {
  const { profile } = data;

  return (
    <header className="flex h-[140px] shrink-0 items-center gap-7 px-6">
      <div className="flex min-w-0 items-center gap-5">
        {profile.user.avatarUrl === null ? (
          <div className="h-[72px] w-[72px] shrink-0 border border-border bg-muted" />
        ) : (
          <img
            alt=""
            className="h-[72px] w-[72px] shrink-0 border border-border object-cover"
            src={profile.user.avatarUrl}
          />
        )}
        <div className="min-w-0">
          <h1 className="truncate text-5xl font-semibold tracking-normal">{profile.user.login}</h1>
        </div>
      </div>
    </header>
  );
}

function StatsGrid({ data }: { data: ProfileOgData }) {
  const { stats } = data.profile;
  const topSpendModel = stats.topModel === null ? "—" : stats.topModel.model;
  const metrics = [
    { label: "Total spend", value: formatOgUsd(stats.totalSpendUsd) },
    { label: "Total tokens", value: formatOgTokens(stats.totalTokens) },
    { label: "Active days", value: formatOgNumber(stats.activeDays) },
    { label: "Current streak", value: formatOgNumber(stats.currentStreakDays) },
    { label: "Sessions", value: formatOgNumber(stats.sessionCount) },
    { label: "Top spend model", value: topSpendModel },
  ];

  return (
    <section className="grid h-[371px] shrink-0 grid-cols-3 grid-rows-[185px_185px] gap-px bg-border">
      {metrics.map((metric) => (
        <div className="flex flex-col justify-center bg-background px-9" key={metric.label}>
          <p className="font-mono text-2xl uppercase text-muted-foreground">{metric.label}</p>
          <p className="mt-5 truncate text-5xl font-semibold tracking-normal">{metric.value}</p>
        </div>
      ))}
    </section>
  );
}

export { ProfileOgCard, Route };

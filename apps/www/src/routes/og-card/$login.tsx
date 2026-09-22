import { createFileRoute, notFound } from "@tanstack/react-router";

import { ProfileOgCard } from "./-components/og-cards";
import { loadProfileOgData } from "../../lib/og-data";

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

export { ProfileOgCard, Route };

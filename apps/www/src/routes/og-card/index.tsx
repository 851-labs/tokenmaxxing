import { createFileRoute } from "@tanstack/react-router";

import { SiteOgCard } from "./-components/og-cards";

const Route = createFileRoute("/og-card/")({
  head: () => ({
    meta: [{ content: "noindex", name: "robots" }],
  }),
  component: SiteOgCard,
});

export { Route };

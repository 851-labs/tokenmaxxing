import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  Scripts,
  useRouterState,
} from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";

import { Footer } from "../components/footer";
import { Nav } from "../components/nav";
import { OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH, SITE_ORIGIN } from "../lib/og";
import geistSans400 from "@fontsource/geist-sans/files/geist-sans-latin-400-normal.woff2?url";
import styles from "../styles.css?url";

interface RouterContext {
  queryClient: QueryClient;
}

const DEFAULT_OG_IMAGE_URL = new URL("/og/pondorasti.png", SITE_ORIGIN).toString();

function rootHead() {
  return {
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "tokenmaxxing.sh" },
      {
        name: "description",
        content: "The social leaderboard for LLM token usage. Sync your agents, climb the ranks.",
      },
      { property: "og:title", content: "tokenmaxxing.sh" },
      {
        property: "og:description",
        content: "The social leaderboard for LLM token usage. Sync your agents, climb the ranks.",
      },
      { property: "og:type", content: "website" },
      { property: "og:url", content: SITE_ORIGIN },
      { property: "og:image", content: DEFAULT_OG_IMAGE_URL },
      { property: "og:image:width", content: String(OG_IMAGE_WIDTH) },
      { property: "og:image:height", content: String(OG_IMAGE_HEIGHT) },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:image", content: DEFAULT_OG_IMAGE_URL },
    ],
    links: [
      {
        rel: "preload",
        as: "font",
        type: "font/woff2",
        href: geistSans400,
        crossOrigin: "anonymous" as const,
      },
      { rel: "stylesheet", href: styles },
    ],
  };
}

const Route = createRootRouteWithContext<RouterContext>()({
  head: rootHead,
  component: RootDocument,
});

function RootDocument() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const isOgCard = pathname.startsWith("/og-card/");

  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen antialiased">
        {isOgCard ? null : <Nav />}
        <main className={isOgCard ? "" : "mx-4 max-w-5xl border-x border-border lg:mx-auto"}>
          <Outlet />
        </main>
        {isOgCard ? null : <Footer />}
        {isOgCard ? null : <Scripts />}
      </body>
    </html>
  );
}

export { DEFAULT_OG_IMAGE_URL, rootHead, Route };

export type { RouterContext };

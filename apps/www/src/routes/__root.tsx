import {
  createRootRouteWithContext,
  HeadContent,
  Link,
  Outlet,
  Scripts,
  useRouterState,
} from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";

import { Footer } from "../components/footer";
import { Nav } from "../components/nav";
import { organizationSchema, webSiteSchema } from "../lib/jsonld";
import { OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH, SITE_ORIGIN } from "../lib/og";
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
    links: [{ rel: "stylesheet", href: styles }],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify(organizationSchema()),
      },
      {
        type: "application/ld+json",
        children: JSON.stringify(webSiteSchema()),
      },
    ],
  };
}

const Route = createRootRouteWithContext<RouterContext>()({
  head: rootHead,
  component: RootDocument,
  notFoundComponent: NotFoundPage,
});

function NotFoundPage() {
  return (
    <div className="mx-auto mt-24 max-w-sm px-4 text-center">
      <h1 className="text-xl font-semibold tracking-tight">Page not found</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        We couldn&apos;t find the page you were looking for.
      </p>
      <Link className="mt-6 inline-flex text-sm font-medium underline underline-offset-4" to="/">
        Back to tokenmaxxing.sh
      </Link>
    </div>
  );
}

function RootDocument() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const isOgCard = pathname.startsWith("/og-card/");

  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen antialiased">
        {isOgCard ? null : (
          <a
            href="#content"
            className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:border focus:border-border focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            Skip to content
          </a>
        )}
        {isOgCard ? null : <Nav />}
        <main
          id="content"
          className={isOgCard ? "" : "mx-4 max-w-5xl border-x border-border lg:mx-auto"}
        >
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

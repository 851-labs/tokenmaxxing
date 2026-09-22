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
import { NotFoundPage } from "../components/not-found";
import { cn } from "../lib/cn";
import {
  DEFAULT_APPLE_TOUCH_ICON_URL,
  FAVICON_MIME_TYPE,
  faviconUrlFromMatches,
} from "../lib/favicon";
import { organizationSchema, webSiteSchema } from "../lib/jsonld";
import { OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH, SITE_OG_IMAGE_URL } from "../lib/og";
import { SITE_DESCRIPTION, SITE_NAME } from "../lib/site";
import styles from "../styles.css?url";

interface RouterContext {
  queryClient: QueryClient;
}

const DEFAULT_OG_IMAGE_URL = SITE_OG_IMAGE_URL;

/**
 * Site-wide defaults. Pages override these by name/property via `pageHead`;
 * og:url and the canonical link are deliberately absent here because only a
 * page knows its own URL.
 */
function rootHead() {
  return {
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: SITE_NAME },
      { name: "description", content: SITE_DESCRIPTION },
      { property: "og:site_name", content: SITE_NAME },
      { property: "og:title", content: SITE_NAME },
      { property: "og:description", content: SITE_DESCRIPTION },
      { property: "og:type", content: "website" },
      { property: "og:image", content: DEFAULT_OG_IMAGE_URL },
      { property: "og:image:width", content: String(OG_IMAGE_WIDTH) },
      { property: "og:image:height", content: String(OG_IMAGE_HEIGHT) },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:image", content: DEFAULT_OG_IMAGE_URL },
    ],
    links: [
      { rel: "apple-touch-icon", href: DEFAULT_APPLE_TOUCH_ICON_URL },
      { rel: "stylesheet", href: styles },
    ],
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

function RootDocument() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const isOgCard = pathname === "/og-card" || pathname.startsWith("/og-card/");

  return (
    <html lang="en">
      <head>
        <FaviconLink />
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
          className={cn(!isOgCard && "mx-4 max-w-5xl border-x border-border lg:mx-auto")}
        >
          <Outlet />
        </main>
        {isOgCard ? null : <Footer />}
        {isOgCard ? null : <Scripts />}
      </body>
    </html>
  );
}

function FaviconLink() {
  const href = useRouterState({ select: (state) => faviconUrlFromMatches(state.matches) });
  return <link rel="icon" href={href} type={FAVICON_MIME_TYPE} />;
}

export { DEFAULT_OG_IMAGE_URL, FaviconLink, rootHead, Route };

export type { RouterContext };

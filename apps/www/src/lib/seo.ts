import { siteUrl } from "./site";

/**
 * Per-page head tags. Child-route meta overrides the root's by name/property,
 * so every page states its own title, description, og:url, and canonical
 * link rather than inheriting the homepage's.
 */

interface PageHeadOptions {
  description?: string;
  /** Extra meta (e.g. og:image overrides) appended after the defaults. */
  meta?: PageMeta[];
  /** Keep the page out of search results; also drops the canonical link. */
  noindex?: boolean;
  /** Site path, e.g. "/privacy". */
  path: string;
  title?: string;
  /** og:type; defaults to "website". */
  type?: string;
}

type PageMeta = { content: string; name: string } | { content: string; property: string };

interface PageHead {
  links: { href: string; rel: string }[];
  meta: ({ title: string } | PageMeta)[];
}

function pageHead({
  description,
  meta = [],
  noindex = false,
  path,
  title,
  type = "website",
}: PageHeadOptions): PageHead {
  const url = siteUrl(path);

  return {
    links: noindex ? [] : [{ href: url, rel: "canonical" }],
    meta: [
      ...(title === undefined ? [] : [{ title }, { content: title, property: "og:title" }]),
      ...(description === undefined
        ? []
        : [
            { content: description, name: "description" },
            { content: description, property: "og:description" },
          ]),
      { content: type, property: "og:type" },
      { content: url, property: "og:url" },
      ...(noindex ? [{ content: "noindex, follow", name: "robots" }] : []),
      ...meta,
    ],
  };
}

export { pageHead };

export type { PageHead, PageHeadOptions, PageMeta };

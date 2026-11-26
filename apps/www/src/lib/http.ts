/** Small Response builders shared by the server-only (non-HTML) routes. */

/**
 * Keeps a non-HTML response out of search results. A file has no `<meta>` to
 * carry `noindex`, so the header is the only way to say it.
 */
const NOINDEX_HEADERS = { "x-robots-tag": "noindex" } as const;

interface TextResponseOptions {
  cacheControl: string;
  contentType?: string;
  /** Extra response headers, e.g. {@link NOINDEX_HEADERS}. */
  headers?: Readonly<Record<string, string>>;
  status?: number;
}

function textResponse(
  body: string,
  {
    cacheControl,
    contentType = "text/plain; charset=utf-8",
    headers = {},
    status = 200,
  }: TextResponseOptions,
): Response {
  return new Response(body, {
    headers: {
      ...headers,
      "cache-control": cacheControl,
      "content-type": contentType,
    },
    status,
  });
}

function notFoundResponse(cacheControl: string): Response {
  return textResponse("Not found", { cacheControl, status: 404 });
}

export { NOINDEX_HEADERS, notFoundResponse, textResponse };

export type { TextResponseOptions };

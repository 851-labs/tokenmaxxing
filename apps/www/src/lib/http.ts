/** Small Response builders shared by the server-only (non-HTML) routes. */

interface TextResponseOptions {
  cacheControl: string;
  contentType?: string;
  status?: number;
}

function textResponse(
  body: string,
  { cacheControl, contentType = "text/plain; charset=utf-8", status = 200 }: TextResponseOptions,
): Response {
  return new Response(body, {
    headers: {
      "cache-control": cacheControl,
      "content-type": contentType,
    },
    status,
  });
}

function notFoundResponse(cacheControl: string): Response {
  return textResponse("Not found", { cacheControl, status: 404 });
}

export { notFoundResponse, textResponse };

export type { TextResponseOptions };

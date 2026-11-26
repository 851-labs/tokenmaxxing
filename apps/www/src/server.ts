import handler, { createServerEntry } from "@tanstack/react-start/server-entry";

import { withSecurityHeaders } from "./lib/security-headers";
import { trailingSlashRedirect } from "./lib/trailing-slash";

/**
 * The default TanStack Start worker entry, plus site-wide security headers
 * and a permanent redirect off trailing-slash URLs.
 */
const server = createServerEntry({
  fetch: async (request, opts) =>
    withSecurityHeaders(
      request,
      trailingSlashRedirect(request) ?? (await handler.fetch(request, opts)),
    ),
});

export default server;

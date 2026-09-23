import handler, { createServerEntry } from "@tanstack/react-start/server-entry";

import { withSecurityHeaders } from "./lib/security-headers";

/** The default TanStack Start worker entry, plus site-wide security headers. */
const server = createServerEntry({
  fetch: async (request, opts) => withSecurityHeaders(request, await handler.fetch(request, opts)),
});

export default server;

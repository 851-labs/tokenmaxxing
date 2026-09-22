import { createFileRoute, redirect } from "@tanstack/react-router";

import { isApiError } from "../lib/api";
import { meQueryOptions } from "../lib/queries";

/**
 * Pathless layout for signed-in pages. The session check is a *loader*, not
 * `beforeLoad`, so it runs in parallel with the child page's loaders instead
 * of ahead of them; the router lets a redirect from any loader win over a
 * sibling's failure, so a signed-out visit still lands on /login.
 */
const Route = createFileRoute("/_authed")({
  loader: async ({ context, location }) => {
    try {
      await context.queryClient.ensureQueryData(meQueryOptions);
    } catch (error) {
      if (isApiError(error, "Unauthorized")) {
        throw redirect({ search: { redirect: location.href }, to: "/login" });
      }

      throw error;
    }
  },
  head: () => ({
    meta: [{ content: "noindex, follow", name: "robots" }],
  }),
});

export { Route };

import { createFileRoute, redirect } from "@tanstack/react-router";

import { ensureViewer } from "../lib/queries";

/**
 * Pathless layout for signed-in pages. The session check is a *loader*, not
 * `beforeLoad`, so it runs in parallel with the child page's loaders instead
 * of ahead of them; the router lets a redirect from any loader win over a
 * sibling's failure, so a signed-out visit still lands on /login.
 */
const Route = createFileRoute("/_authed")({
  loader: async ({ context, location }) => {
    if ((await ensureViewer(context.queryClient)) === null) {
      throw redirect({ search: { redirect: location.href }, to: "/login" });
    }
  },
  head: () => ({
    meta: [{ content: "noindex, follow", name: "robots" }],
  }),
});

export { Route };

import { QueryClient } from "@tanstack/react-query";
import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";

import { NotFoundPage } from "./components/not-found";
import { RouteErrorPage, RoutePending } from "./components/route-status";
import { isRetryableApiError } from "./lib/api";
import { routeTree } from "./routeTree.gen";

/** Browser-side retries for transient failures; SSR answers immediately. */
const MAX_CLIENT_RETRIES = 2;

function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  return (
    typeof window !== "undefined" && failureCount < MAX_CLIENT_RETRIES && isRetryableApiError(error)
  );
}

function createRouter() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: shouldRetryQuery,
      },
    },
  });

  const router = createTanStackRouter({
    context: {
      queryClient,
    },
    defaultErrorComponent: RouteErrorPage,
    defaultHashScrollIntoView: { behavior: "smooth", block: "start" },
    defaultNotFoundComponent: NotFoundPage,
    defaultPendingComponent: RoutePending,
    defaultPreload: "intent",
    // TanStack Query owns caching; let every preload consult it.
    defaultPreloadStaleTime: 0,
    routeTree,
    scrollRestoration: true,
  });

  setupRouterSsrQueryIntegration({ queryClient, router });

  return router;
}

const getRouter = createRouter;

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createRouter>;
  }
}

export { createRouter, getRouter, shouldRetryQuery };

import { useQueryErrorResetBoundary } from "@tanstack/react-query";
import { Link, useRouter, useRouterState, type ErrorComponentProps } from "@tanstack/react-router";

import { errorMessage, isApiError } from "../lib/api";
import { Button } from "./ui/button";

/** Router-wide fallback when a loader or render throws. */
function RouteErrorPage({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  const queryErrorReset = useQueryErrorResetBoundary();
  const href = useRouterState({ select: (state) => state.location.href });

  // A session that expired after the page's guard ran: offer a fresh sign-in.
  if (isApiError(error, "Unauthorized")) {
    return (
      <div className="mx-auto mt-24 max-w-sm px-4 text-center" role="alert">
        <h1 className="text-xl font-semibold tracking-tight">Your session has ended</h1>
        <p className="mt-2 text-sm text-muted-foreground">Sign in again to continue.</p>
        <Link
          className="mt-6 inline-flex text-sm font-medium underline underline-offset-4"
          search={{ redirect: href }}
          to="/login"
        >
          Sign in
        </Link>
      </div>
    );
  }

  const retry = () => {
    queryErrorReset.reset();
    reset();
    void router.invalidate();
  };

  return (
    <div className="mx-auto mt-24 max-w-sm px-4 text-center" role="alert">
      <h1 className="text-xl font-semibold tracking-tight">Something went wrong</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {errorMessage(error, "This page failed to load. It may be a temporary problem.")}
      </p>
      <div className="mt-6 flex items-center justify-center gap-4">
        <Button onClick={retry} size="sm" variant="primary">
          Try again
        </Button>
        <Link className="text-sm font-medium underline underline-offset-4" to="/">
          Back to tokenmaxxing.sh
        </Link>
      </div>
    </div>
  );
}

/** Shown when a navigation's loaders take longer than the router's pendingMs. */
function RoutePending() {
  return (
    <div aria-busy="true" className="px-4 py-8 text-sm text-muted-foreground" role="status">
      Loading…
    </div>
  );
}

export { RouteErrorPage, RoutePending };

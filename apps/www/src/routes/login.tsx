import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { LOGIN_OAUTH_PROVIDERS, OAuthProviderButtons } from "../components/oauth-providers";
import { Card } from "../components/ui/card";
import { SITE_ORIGIN } from "../lib/og";

const LOGIN_TITLE = "Sign in — tokenmaxxing.sh";
const LOGIN_DESCRIPTION =
  "Sign in to tokenmaxxing.sh to sync your LLM agent usage and track your spot on the leaderboard.";
const LOGIN_URL = new URL("/login", SITE_ORIGIN).toString();

const loginRedirectSchema = z.preprocess(
  (value) => (typeof value === "string" ? sanitizeLoginRedirectPath(value) : undefined),
  z.string().optional(),
);

const loginSearchSchema = z.object({
  redirect: loginRedirectSchema,
});

const Route = createFileRoute("/login")({
  validateSearch: loginSearchSchema,
  head: () => ({
    meta: [
      { title: LOGIN_TITLE },
      { content: LOGIN_DESCRIPTION, name: "description" },
      { content: LOGIN_TITLE, property: "og:title" },
      { content: LOGIN_DESCRIPTION, property: "og:description" },
      { content: LOGIN_URL, property: "og:url" },
      { content: "noindex, follow", name: "robots" },
    ],
  }),
  component: LoginPage,
});

function LoginPage() {
  const { redirect } = Route.useSearch();

  return (
    <div className="flex min-h-[calc(100vh-12rem)] items-center px-4 py-8">
      <Card className="mx-auto flex w-full max-w-sm flex-col items-center p-8 text-center">
        <h1 className="text-xl font-semibold tracking-tight">Welcome to tokenmaxxing.sh</h1>
        <p className="mt-2 text-sm text-muted-foreground">The best place to track token usage.</p>
        <OAuthProviderButtons
          className="mt-6"
          providers={LOGIN_OAUTH_PROVIDERS}
          redirect={redirect}
        />
      </Card>
    </div>
  );
}

function sanitizeLoginRedirectPath(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) {
    return undefined;
  }

  try {
    const url = new URL(trimmed, "https://tokenmaxxing.invalid");
    if (url.origin !== "https://tokenmaxxing.invalid") {
      return undefined;
    }

    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return undefined;
  }
}

export { Route };

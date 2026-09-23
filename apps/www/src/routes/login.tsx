import { createFileRoute } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { LOGIN_OAUTH_PROVIDERS, OAuthProviderButtons } from "../components/oauth-providers";
import { Card } from "../components/ui/card";
import { SITE_ORIGIN } from "../lib/og";
import { optionalSearchParam } from "../lib/search";

const LOGIN_TITLE = "Sign in — tokenmaxxing.sh";
const LOGIN_DESCRIPTION =
  "Sign in to tokenmaxxing.sh to sync your LLM agent usage and track your spot on the leaderboard.";
const LOGIN_URL = new URL("/login", SITE_ORIGIN).toString();

/** Any value decodes; only same-origin paths survive as a redirect target. */
const loginRedirectSchema = Schema.Unknown.pipe(
  Schema.decodeTo(
    Schema.UndefinedOr(Schema.String),
    SchemaTransformation.transform({
      decode: (value) => (typeof value === "string" ? sanitizeLoginRedirectPath(value) : undefined),
      encode: (value) => value,
    }),
  ),
);

/** Codes the API's OAuth callback redirects back with (apps/api/src/http/routes/oauth.ts). */
const LOGIN_ERROR_CODES = [
  "oauth_account_conflict",
  "oauth_cancelled",
  "oauth_failed",
  "oauth_state_mismatch",
] as const;

type LoginErrorCode = (typeof LOGIN_ERROR_CODES)[number];

const LOGIN_PROVIDER_LABELS = { github: "GitHub", google: "Google" } as const;

type LoginProvider = keyof typeof LOGIN_PROVIDER_LABELS;

const loginSearchSchema = Schema.toStandardSchemaV1(
  Schema.Struct({
    error: optionalSearchParam(Schema.Literals(LOGIN_ERROR_CODES)),
    provider: optionalSearchParam(Schema.Literals(["github", "google"] satisfies LoginProvider[])),
    redirect: Schema.optionalKey(loginRedirectSchema),
  }),
);

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
  const { error, provider, redirect } = Route.useSearch();

  return (
    <div className="flex min-h-[calc(100vh-12rem)] items-center px-4 py-8">
      <Card className="mx-auto flex w-full max-w-sm flex-col items-center p-8 text-center">
        <h1 className="text-xl font-semibold tracking-tight">Welcome to tokenmaxxing.sh</h1>
        <p className="mt-2 text-sm text-muted-foreground">The best place to track token usage.</p>
        {error === undefined ? null : (
          <p className="mt-4 text-sm text-red-500" role="alert">
            {loginErrorMessage(error, provider)}
          </p>
        )}
        <OAuthProviderButtons
          className="mt-6"
          providers={LOGIN_OAUTH_PROVIDERS}
          redirect={redirect}
        />
      </Card>
    </div>
  );
}

function loginErrorMessage(error: LoginErrorCode, provider?: LoginProvider): string {
  const label = provider === undefined ? null : LOGIN_PROVIDER_LABELS[provider];
  switch (error) {
    case "oauth_account_conflict":
      return `That ${label ?? "provider"} account is already connected to another tokenmaxxing profile.`;
    case "oauth_cancelled":
      return `${label ?? "Provider"} sign-in was cancelled.`;
    case "oauth_failed":
      return `${label ?? "Provider"} sign-in failed; try again.`;
    case "oauth_state_mismatch":
      return "Sign-in expired; try again.";
  }
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

    // Dot segments can normalise "/.//evil.com" to "//evil.com"; judge the output.
    const path = `${url.pathname}${url.search}${url.hash}`;
    return path.startsWith("//") ? undefined : path;
  } catch {
    return undefined;
  }
}

export { loginErrorMessage, loginSearchSchema, Route, sanitizeLoginRedirectPath };

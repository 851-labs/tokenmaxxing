import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { CheckCircle, TerminalWindow, WarningCircle } from "@phosphor-icons/react/ssr";
import type { CliLoginRequestSummary } from "@tokenmaxxing/api-contract";
import * as Schema from "effect/Schema";

import { LOGIN_OAUTH_PROVIDERS, OAuthProviderButtons } from "../components/oauth-providers";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Code } from "../components/ui/code";
import { errorMessage, runApi } from "../lib/api";
import { cliLoginRequestQueryOptions, meQueryOptions } from "../lib/queries";
import { searchParam } from "../lib/search";
import { pageHead } from "../lib/seo";

/**
 * Approval screen for `tokenmaxxing login`. Approving hands the requesting
 * device a never-expiring token for the signed-in account, so it only ever
 * happens on an explicit click after the device details are shown — a link
 * someone else sent must never approve anything by merely being opened.
 */

const cliLoginSearchSchema = Schema.toStandardSchemaV1(
  Schema.Struct({
    code: searchParam(Schema.String, ""),
  }),
);

const Route = createFileRoute("/login_/cli")({
  validateSearch: cliLoginSearchSchema,
  head: cliLoginHead,
  component: CliLoginPage,
});

/**
 * Codes are one-time and per-device: keep the page out of search results and
 * its code out of og:url.
 */
function cliLoginHead() {
  return pageHead({
    description: "Approve a tokenmaxxing CLI sign-in for your account.",
    noindex: true,
    path: "/login/cli",
    title: "Connect your CLI — tokenmaxxing.sh",
  });
}

function CliLoginPage() {
  const { code } = Route.useSearch();

  return <CliLoginApproval code={code} />;
}

function CliLoginApproval({ code }: { code: string }) {
  const me = useQuery(meQueryOptions);
  const request = useQuery({
    ...cliLoginRequestQueryOptions(code),
    enabled: code !== "" && me.isSuccess,
  });
  const approve = useMutation({
    mutationFn: () => runApi((client) => client.me.approveCliLogin({ payload: { code } })),
  });

  return (
    <div className="flex min-h-[calc(100vh-12rem)] items-center px-4 py-8">
      <Card className="mx-auto flex w-full max-w-sm flex-col items-center p-8 text-center">
        <TerminalWindow className="size-8 text-muted-foreground" />
        <h1 className="mt-4 text-xl font-semibold tracking-tight">Connect your CLI</h1>

        {code === "" ? (
          <p className="mt-2 text-sm text-muted-foreground">
            Missing login code. Run <Code>tokenmaxxing login</Code> and follow the link it prints.
          </p>
        ) : me.isPending ? (
          <p className="mt-2 text-sm text-muted-foreground">Checking your session…</p>
        ) : me.isError ? (
          <>
            <p className="mt-2 text-sm text-muted-foreground">
              Log in to review code <Code>{code}</Code>.
            </p>
            <OAuthProviderButtons
              className="mt-6"
              providers={LOGIN_OAUTH_PROVIDERS}
              redirect={cliLoginRedirectPath(code)}
            />
          </>
        ) : approve.isSuccess ? (
          <>
            <p className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
              <CheckCircle className="size-4 text-accent" />
              Approved <span className="font-medium">{approve.data.deviceName}</span>.
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              Head back to your terminal — the CLI is logging in now.
            </p>
          </>
        ) : request.isPending ? (
          <p className="mt-2 text-sm text-muted-foreground">Looking up code…</p>
        ) : request.isError ? (
          <p className="mt-2 text-sm text-muted-foreground">
            {errorMessage(
              request.error,
              "This login code is invalid or has expired. Run `tokenmaxxing login` again.",
            )}
          </p>
        ) : request.data.status === "approved" ? (
          <p className="mt-2 text-sm text-muted-foreground">
            Code <Code>{code}</Code> has already been approved.
          </p>
        ) : (
          <>
            <p className="mt-2 text-sm text-muted-foreground">
              A device is asking to sign in as{" "}
              <span className="font-medium">{me.data.user.login}</span> with code{" "}
              <Code>{request.data.code}</Code>.
            </p>
            <CliLoginDeviceDetails request={request.data} />
            <p className="mt-4 flex items-start gap-2 text-left text-xs text-muted-foreground">
              <WarningCircle className="mt-0.5 size-4 shrink-0 text-red-500" />
              <span>
                Only approve if you just ran <Code>tokenmaxxing login</Code> yourself and your
                terminal shows this code. The device will be able to push usage to your profile
                until you revoke it. Never approve a link someone else sent you.
              </span>
            </p>
            {approve.isError ? (
              <p className="mt-3 text-sm text-red-500">
                {errorMessage(approve.error, "Approval failed; run `tokenmaxxing login` again.")}
              </p>
            ) : null}
            <Button
              className="mt-6"
              disabled={approve.isPending}
              fullWidth
              onClick={() => approve.mutate()}
              size="md"
              variant="primary"
            >
              {approve.isPending ? "Approving…" : `Approve ${request.data.deviceName}`}
            </Button>
          </>
        )}
      </Card>
    </div>
  );
}

function CliLoginDeviceDetails({ request }: { request: CliLoginRequestSummary }) {
  const platform = [request.devicePlatform, request.deviceArch].filter(Boolean).join(" · ");

  return (
    <dl className="mt-4 grid w-full grid-cols-[auto_1fr] gap-x-4 gap-y-1 border border-border p-3 text-left text-sm">
      <dt className="text-muted-foreground">Device</dt>
      <dd className="truncate font-medium">{request.deviceName}</dd>
      <dt className="text-muted-foreground">Platform</dt>
      <dd>{platform}</dd>
      <dt className="text-muted-foreground">CLI</dt>
      <dd>
        {request.deviceVersion ?? "unknown version"}
        {request.legacyClient ? " (outdated — upgrade after logging in)" : null}
      </dd>
      <dt className="text-muted-foreground">Requested</dt>
      <dd>{new Date(request.createdAt).toLocaleTimeString()}</dd>
    </dl>
  );
}

function cliLoginRedirectPath(code: string): string {
  return `/login/cli?${new URLSearchParams({ code }).toString()}`;
}

export { CliLoginApproval, cliLoginHead, Route };

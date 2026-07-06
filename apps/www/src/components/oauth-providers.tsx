import { buttonClassName } from "./ui/button";
import { cn } from "../lib/cn";
import { resolveApiUrl } from "../lib/config";

type OAuthProviderId = "github" | "google";
type OAuthProviderAction = "connect" | "continue";

const OAUTH_PROVIDERS = [
  { id: "github", name: "GitHub" },
  { id: "google", name: "Google" },
] as const satisfies { id: OAuthProviderId; name: string }[];

const LOGIN_OAUTH_PROVIDERS = ["github"] as const satisfies readonly OAuthProviderId[];

interface OAuthProviderLink {
  href: string;
  id: OAuthProviderId;
  label: string;
}

interface OAuthProviderOptions {
  action?: OAuthProviderAction | undefined;
  providers?: readonly OAuthProviderId[] | undefined;
  redirect?: string | undefined;
}

interface OAuthProviderButtonsProps extends OAuthProviderOptions {
  className?: string | undefined;
}

function GitHubMark({ className }: { className?: string }) {
  return (
    <svg aria-hidden className={className} fill="currentColor" viewBox="0 0 16 16">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

function GoogleMark({ className }: { className?: string }) {
  return (
    <svg aria-hidden className={className} viewBox="0 0 18 18">
      <path
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"
        fill="#4285F4"
      />
      <path
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.35 0-4.34-1.58-5.05-3.72H.93v2.33A9 9 0 0 0 9 18Z"
        fill="#34A853"
      />
      <path
        d="M3.95 10.7A5.4 5.4 0 0 1 3.67 9c0-.59.1-1.16.28-1.7V4.97H.93A9 9 0 0 0 0 9c0 1.45.34 2.82.93 4.03l3.02-2.33Z"
        fill="#FBBC05"
      />
      <path
        d="M9 3.58c1.32 0 2.5.45 3.43 1.34l2.59-2.58A8.64 8.64 0 0 0 9 0 9 9 0 0 0 .93 4.97L3.95 7.3C4.66 5.16 6.65 3.58 9 3.58Z"
        fill="#EA4335"
      />
    </svg>
  );
}

function OAuthProviderButtons({
  action,
  className,
  providers,
  redirect,
}: OAuthProviderButtonsProps) {
  return (
    <div className={cn("flex w-full flex-col gap-3", className)}>
      {oauthProviderLinks({ action, providers, redirect }).map((provider) => (
        <a
          className={buttonClassName({ variant: "primary", size: "md", fullWidth: true })}
          href={provider.href}
          key={provider.id}
        >
          {providerIcon(provider.id)}
          {provider.label}
        </a>
      ))}
    </div>
  );
}

function oauthProviderLinks({
  action = "continue",
  providers,
  redirect,
}: OAuthProviderOptions = {}): OAuthProviderLink[] {
  const enabledProviders =
    providers === undefined ? undefined : new Set<OAuthProviderId>(providers);

  return OAUTH_PROVIDERS.filter(
    (provider) => enabledProviders === undefined || enabledProviders.has(provider.id),
  ).map((provider) => {
    const url = new URL(`${resolveApiUrl()}/auth/${provider.id}/start`);
    if (redirect !== undefined) {
      url.searchParams.set("redirect", redirect);
    }

    return {
      href: url.toString(),
      id: provider.id,
      label: oauthProviderActionLabel(action, provider.name),
    };
  });
}

function oauthProviderActionLabel(action: OAuthProviderAction, providerName: string): string {
  switch (action) {
    case "connect":
      return `Connect ${providerName}`;
    case "continue":
      return `Continue with ${providerName}`;
  }
}

function providerIcon(provider: OAuthProviderId) {
  switch (provider) {
    case "github":
      return <GitHubMark className="size-4" />;
    case "google":
      return <GoogleMark className="size-4" />;
  }
}

function oauthProviderLabel(provider: OAuthProviderId): string {
  return OAUTH_PROVIDERS.find((entry) => entry.id === provider)?.name ?? provider;
}

export { LOGIN_OAUTH_PROVIDERS, OAuthProviderButtons, oauthProviderLabel, oauthProviderLinks };

export type { OAuthProviderAction, OAuthProviderId };

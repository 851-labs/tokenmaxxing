import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { DeviceSummary, UserAccountSummary } from "@tokenmaxxing/api-contract";
import { Key, Laptop, LinkSimple } from "@phosphor-icons/react/ssr";

import {
  OAuthProviderButtons,
  oauthProviderLabel,
  type OAuthProviderId,
} from "../components/oauth-providers";
import { Avatar } from "../components/ui/avatar";
import { Button } from "../components/ui/button";
import { Code } from "../components/ui/code";
import { errorMessage, isApiError, runApi } from "../lib/api";
import {
  accountsQueryOptions,
  devicesQueryOptions,
  meQueryOptions,
  tokensQueryOptions,
} from "../lib/queries";

const SETTINGS_PATH = "/settings";
const ACCOUNT_PROVIDERS = ["github", "google"] as const satisfies readonly OAuthProviderId[];

type Account = typeof UserAccountSummary.Type;
type Device = typeof DeviceSummary.Type;
type DeviceDeleteInvalidationKey = readonly unknown[];

const Route = createFileRoute("/settings")({
  loader: async ({ context }) => {
    try {
      await context.queryClient.ensureQueryData(meQueryOptions);
      await Promise.all([
        context.queryClient.ensureQueryData(accountsQueryOptions),
        context.queryClient.ensureQueryData(devicesQueryOptions),
        context.queryClient.ensureQueryData(tokensQueryOptions),
      ]);
    } catch (error) {
      if (isApiError(error, "Unauthorized")) {
        throw redirect({
          search: { redirect: SETTINGS_PATH },
          to: "/login",
        });
      }

      throw error;
    }
  },
  head: () => ({
    meta: [{ content: "noindex, follow", name: "robots" }],
  }),
  component: SettingsPage,
});

function SettingsPage() {
  const { data: me } = useSuspenseQuery(meQueryOptions);

  return (
    <div className="flex flex-col gap-10 px-4 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <AccountsSection />
      <DevicesSection login={me.user.login} />
      <TokensSection />
    </div>
  );
}

function AccountsSection() {
  const { data } = useSuspenseQuery(accountsQueryOptions);
  const connectedProviders = new Set(data.accounts.map((account) => account.provider));
  const missingProviders = ACCOUNT_PROVIDERS.filter(
    (provider) => !connectedProviders.has(provider),
  );

  return (
    <section>
      <h2 className="flex items-center gap-2 text-lg font-medium">
        <LinkSimple className="size-4" /> Connected accounts
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Linked accounts share one public profile; existing usage, devices, and CLI tokens move here
        when profiles merge.
      </p>
      <div className="-mx-4 mt-4 overflow-hidden border-y border-border">
        <table className="w-full text-sm">
          <tbody>
            {data.accounts.map((account) => (
              <tr
                className="border-b border-border last:border-b-0"
                key={`${account.provider}:${account.providerAccountId}`}
              >
                <td className="p-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <Avatar alt={accountLabel(account)} size="sm" src={account.avatarUrl} />
                    <div className="min-w-0">
                      <p className="truncate font-medium">{accountLabel(account)}</p>
                      <p className="truncate text-muted-foreground">{accountSecondary(account)}</p>
                    </div>
                  </div>
                </td>
                <td className="p-3 text-right text-muted-foreground">
                  {oauthProviderLabel(account.provider)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {missingProviders.length > 0 ? (
        <OAuthProviderButtons
          action="connect"
          className="mt-4 max-w-sm"
          providers={missingProviders}
          redirect={SETTINGS_PATH}
        />
      ) : null}
    </section>
  );
}

function accountLabel(account: Account): string {
  return account.login ?? account.name ?? account.email ?? oauthProviderLabel(account.provider);
}

function accountSecondary(account: Account): string {
  if (account.email !== null) {
    return account.emailVerified ? `${account.email} verified` : account.email;
  }

  return account.providerAccountId;
}

function DevicesSection({ login }: { login: string }) {
  const queryClient = useQueryClient();
  const { data } = useSuspenseQuery(devicesQueryOptions);
  const deleteDevice = useMutation({
    mutationFn: (device: Device) =>
      runApi((client) => client.me.deleteDevice({ params: { deviceId: device.id } })),
    onSuccess: async () => {
      await Promise.all(
        deviceDeleteInvalidationKeys(login).map((queryKey) =>
          queryClient.invalidateQueries({ queryKey }),
        ),
      );
    },
  });

  const requestDelete = (device: Device) => {
    if (!confirmDeviceDelete(device)) {
      return;
    }

    deleteDevice.mutate(device);
  };

  return (
    <section>
      <h2 className="flex items-center gap-2 text-lg font-medium">
        <Laptop className="size-4" /> Devices
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Every machine that has pushed usage. Aggregates on your profile span all of them.
      </p>
      {deleteDevice.isError ? (
        <p className="mt-2 text-sm text-red-500">
          {errorMessage(deleteDevice.error, "Delete failed; refresh and try again.")}
        </p>
      ) : null}
      <div className="-mx-4 mt-4 overflow-hidden border-y border-border">
        {data.devices.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            No devices yet — run <Code>tokenmaxxing login</Code> on a machine to add it.
          </p>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {data.devices.map((device) => (
                <tr className="border-b border-border last:border-b-0" key={device.id}>
                  <td className="p-3 font-medium">{device.name}</td>
                  <td className="p-3 text-muted-foreground">{device.platform}</td>
                  <td className="p-3 text-right text-muted-foreground">
                    {device.lastSyncAt === null
                      ? "never synced"
                      : `synced ${new Date(device.lastSyncAt).toLocaleString()}`}
                  </td>
                  <td className="p-3 text-right">
                    <Button
                      disabled={deleteDevice.isPending}
                      onClick={() => requestDelete(device)}
                      variant="destructive"
                    >
                      Delete data
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function TokensSection() {
  const queryClient = useQueryClient();
  const { data } = useSuspenseQuery(tokensQueryOptions);
  const revoke = useMutation({
    mutationFn: (tokenId: string) =>
      runApi((client) => client.me.revokeToken({ params: { tokenId } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: tokensQueryOptions.queryKey }),
  });

  return (
    <section>
      <h2 className="flex items-center gap-2 text-lg font-medium">
        <Key className="size-4" /> CLI tokens
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Tokens never expire — revoking here (or `tokenmaxxing logout` on the device) is the only
        kill switch.
      </p>
      {revoke.isError ? (
        <p className="mt-2 text-sm text-red-500">
          {errorMessage(revoke.error, "Revoke failed; refresh and try again.")}
        </p>
      ) : null}
      <div className="-mx-4 mt-4 overflow-hidden border-y border-border">
        {data.tokens.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No active CLI tokens.</p>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {data.tokens.map((token) => (
                <tr className="border-b border-border last:border-b-0" key={token.id}>
                  <td className="p-3 font-medium">{token.name ?? "unnamed"}</td>
                  <td className="p-3 text-muted-foreground">
                    {token.lastUsedAt === null
                      ? "never used"
                      : `used ${new Date(token.lastUsedAt).toLocaleString()}`}
                  </td>
                  <td className="p-3 text-right">
                    <Button
                      disabled={revoke.isPending}
                      onClick={() => revoke.mutate(token.id)}
                      variant="destructive"
                    >
                      Revoke
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function deviceDeleteConfirmationMessage(deviceName: string): string {
  return `Delete synced usage for ${deviceName}? This removes the device from your profile and revokes its CLI tokens.`;
}

function confirmDeviceDelete(
  device: Pick<Device, "name">,
  confirm: (message: string) => boolean = window.confirm,
): boolean {
  return confirm(deviceDeleteConfirmationMessage(device.name));
}

function deviceDeleteInvalidationKeys(login: string): DeviceDeleteInvalidationKey[] {
  return [devicesQueryOptions.queryKey, tokensQueryOptions.queryKey, ["profile", login]];
}

export { Route };

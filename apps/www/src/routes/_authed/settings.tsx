import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { CliTokenSummary, DeviceSummary } from "@tokenmaxxing/api-contract";
import { Key, Laptop } from "@phosphor-icons/react/ssr";

import { LocalDateTime } from "../../components/local-date-time";
import { Button } from "../../components/ui/button";
import { Code } from "../../components/ui/code";
import { ErrorText } from "../../components/ui/error-text";
import { errorMessage, runApi } from "../../lib/api";
import {
  devicesQueryOptions,
  invalidatePublicViews,
  meQueryOptions,
  queryKeys,
  tokensQueryOptions,
} from "../../lib/queries";
import { pageHead } from "../../lib/seo";

type Device = typeof DeviceSummary.Type;
type CliToken = typeof CliTokenSummary.Type;

const Route = createFileRoute("/_authed/settings")({
  // The session check in `_authed` runs alongside this, so all three reads
  // start together.
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(meQueryOptions),
      context.queryClient.ensureQueryData(devicesQueryOptions),
      context.queryClient.ensureQueryData(tokensQueryOptions),
    ]);
  },
  head: () => pageHead({ noindex: true, path: "/settings", title: "Settings — tokenmaxxing.sh" }),
  component: SettingsPage,
});

function SettingsPage() {
  const { data: me } = useSuspenseQuery(meQueryOptions);

  return (
    <div className="flex flex-col gap-10 px-4 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <DevicesSection login={me.user.login} />
      <TokensSection />
    </div>
  );
}

function DevicesSection({ login }: { login: string }) {
  const queryClient = useQueryClient();
  const { data } = useSuspenseQuery(devicesQueryOptions);
  const deleteDevice = useMutation({
    mutationFn: (device: Device) =>
      runApi((client) => client.me.deleteDevice({ params: { deviceId: device.id } })),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.devices }),
        queryClient.invalidateQueries({ queryKey: queryKeys.tokens }),
        invalidatePublicViews(queryClient, login),
      ]);
    },
  });

  const requestDelete = (device: Device) => {
    if (window.confirm(deviceDeleteConfirmationMessage(device.name))) {
      deleteDevice.mutate(device);
    }
  };

  return (
    <section aria-labelledby="settings-devices-title">
      <h2 className="flex items-center gap-2 text-lg font-medium" id="settings-devices-title">
        <Laptop aria-hidden="true" className="size-4" /> Devices
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Every machine that has pushed usage. Aggregates on your profile span all of them.
      </p>
      {deleteDevice.isError ? (
        <ErrorText className="mt-2">
          {errorMessage(deleteDevice.error, "Delete failed; refresh and try again.")}
        </ErrorText>
      ) : null}
      <div className="-mx-4 mt-4 overflow-hidden border-y border-border">
        {data.devices.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            No devices yet — run <Code>tokenmaxxing login</Code> on a machine to add it.
          </p>
        ) : (
          <table className="w-full text-sm">
            <caption className="sr-only">Your synced devices</caption>
            <tbody>
              {data.devices.map((device) => (
                <tr className="border-b border-border last:border-b-0" key={device.id}>
                  <th className="p-3 text-left font-medium" scope="row">
                    {device.name}
                  </th>
                  <td className="p-3 text-muted-foreground">{device.platform}</td>
                  <td className="p-3 text-right text-muted-foreground">
                    {device.lastSyncAt === null ? (
                      "never synced"
                    ) : (
                      <>
                        synced <LocalDateTime iso={device.lastSyncAt} />
                      </>
                    )}
                  </td>
                  <td className="p-3 text-right">
                    <Button
                      aria-label={`Delete data for ${device.name}`}
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
    mutationFn: (token: CliToken) =>
      runApi((client) => client.me.revokeToken({ params: { tokenId: token.id } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.tokens }),
  });

  const requestRevoke = (token: CliToken) => {
    if (window.confirm(tokenRevokeConfirmationMessage(tokenLabel(token)))) {
      revoke.mutate(token);
    }
  };

  return (
    <section aria-labelledby="settings-tokens-title">
      <h2 className="flex items-center gap-2 text-lg font-medium" id="settings-tokens-title">
        <Key aria-hidden="true" className="size-4" /> CLI tokens
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Tokens never expire — revoking here (or `tokenmaxxing logout` on the device) is the only
        kill switch.
      </p>
      {revoke.isError ? (
        <ErrorText className="mt-2">
          {errorMessage(revoke.error, "Revoke failed; refresh and try again.")}
        </ErrorText>
      ) : null}
      <div className="-mx-4 mt-4 overflow-hidden border-y border-border">
        {data.tokens.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No active CLI tokens.</p>
        ) : (
          <table className="w-full text-sm">
            <caption className="sr-only">Your active CLI tokens</caption>
            <tbody>
              {data.tokens.map((token) => (
                <tr className="border-b border-border last:border-b-0" key={token.id}>
                  <th className="p-3 text-left font-medium" scope="row">
                    {tokenLabel(token)}
                  </th>
                  <td className="p-3 text-muted-foreground">
                    {token.lastUsedAt === null ? (
                      "never used"
                    ) : (
                      <>
                        used <LocalDateTime iso={token.lastUsedAt} />
                      </>
                    )}
                  </td>
                  <td className="p-3 text-right">
                    <Button
                      aria-label={`Revoke token ${tokenLabel(token)}`}
                      disabled={revoke.isPending}
                      onClick={() => requestRevoke(token)}
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

function tokenLabel(token: Pick<CliToken, "name">): string {
  return token.name ?? "unnamed";
}

function deviceDeleteConfirmationMessage(deviceName: string): string {
  return `Delete synced usage for ${deviceName}? This removes the device from your profile and revokes its CLI tokens.`;
}

function tokenRevokeConfirmationMessage(tokenName: string): string {
  return `Revoke CLI token ${tokenName}? Any device using it is signed out and stops syncing until you run \`tokenmaxxing login\` there again.`;
}

export { Route };

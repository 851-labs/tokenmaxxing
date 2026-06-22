import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, notFound, redirect } from "@tanstack/react-router";
import type {
  AdminDeviceStatus,
  AdminUsersResponse,
  ServiceRepairReasonValue,
} from "@tokenmaxxing/api-contract";

import { Avatar } from "../components/ui/avatar";
import { Badge } from "../components/ui/badge";
import { isApiError } from "../lib/api";
import { adminUsersQueryOptions } from "../lib/queries";

const INTERNAL_PATH = "/internal";

type AdminUsersData = typeof AdminUsersResponse.Type;

const Route = createFileRoute("/internal")({
  loader: async ({ context }) => {
    try {
      await context.queryClient.ensureQueryData(adminUsersQueryOptions);
    } catch (error) {
      if (isApiError(error, "Unauthorized")) {
        throw redirect({
          search: { redirect: INTERNAL_PATH },
          to: "/login",
        });
      }
      if (isApiError(error, "Forbidden")) {
        throw notFound();
      }

      throw error;
    }
  },
  head: () => ({
    meta: [{ content: "noindex, follow", name: "robots" }],
  }),
  component: InternalPage,
  notFoundComponent: NotFoundPage,
});

function InternalPage() {
  const { data } = useSuspenseQuery(adminUsersQueryOptions);

  return (
    <>
      <header className="px-4 py-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Internal</h1>
          <p className="mt-1 text-sm text-muted-foreground">{fleetSummary(data)}</p>
        </div>
      </header>
      <dl className="grid gap-px border-y border-border bg-border text-sm sm:grid-cols-3">
        <SummaryCell label="Latest CLI" value={formatVersion(data.latestCliVersion)} />
        <SummaryCell label="Users" value={formatInteger(data.summary.totalUsers)} />
        <SummaryCell label="Devices" value={formatInteger(data.summary.totalDevices)} />
      </dl>
      <div className="overflow-x-auto border-b border-border">
        <table className="w-full min-w-[72rem] table-fixed text-left text-sm">
          <thead className="border-b border-border bg-muted/40 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="w-[18%] p-3 font-medium">Machine</th>
              <th className="w-[15%] p-3 font-medium">User</th>
              <th className="w-[16%] p-3 font-medium">Version</th>
              <th className="hidden w-[12%] whitespace-nowrap p-3 font-medium lg:table-cell">
                System
              </th>
              <th className="w-[17%] p-3 font-medium">Status</th>
              <th className="w-[12%] p-3 font-medium">Last check-in</th>
              <th className="hidden w-[10%] whitespace-nowrap p-3 font-medium md:table-cell">
                Last usage
              </th>
            </tr>
          </thead>
          <tbody>
            {data.devices.map((row) => (
              <tr className="border-b border-border last:border-b-0" key={row.device.id}>
                <td className="p-3 align-top">
                  <div className="truncate font-medium" title={row.device.name}>
                    {row.device.name}
                  </div>
                </td>
                <td className="p-3 align-top">
                  <Link
                    className="flex items-center gap-2.5 font-medium hover:underline"
                    params={{ user: row.user.login }}
                    to="/$user"
                  >
                    <Avatar size={24} src={row.user.avatarUrl} />
                    {row.user.login}
                  </Link>
                </td>
                <td className="p-3 align-top">
                  <VersionCell row={row} />
                </td>
                <td className="hidden whitespace-nowrap p-3 align-top font-mono text-muted-foreground lg:table-cell">
                  {formatDeviceSystem(row.device)}
                </td>
                <td className="p-3 align-top">
                  <StatusCell row={row} title={serviceStatusTitle(row)} />
                </td>
                <td className="p-3 align-top">
                  <div title={row.latestCheckInAt ?? undefined}>
                    {formatRelativeTime(row.latestCheckInAt, data.generatedAt)}
                  </div>
                </td>
                <td className="hidden whitespace-nowrap p-3 align-top font-mono text-muted-foreground md:table-cell">
                  {row.lastUsageDate ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function NotFoundPage() {
  return (
    <div className="mx-auto mt-24 max-w-sm text-center">
      <h1 className="text-xl font-semibold tracking-tight">Not found</h1>
      <p className="mt-2 text-sm text-muted-foreground">This page does not exist.</p>
    </div>
  );
}

function SummaryCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-background p-4">
      <dt className="text-xs uppercase text-muted-foreground">{label}</dt>
      <dd className="mt-1 font-mono text-base font-semibold">{value}</dd>
    </div>
  );
}

function StatusPill({ status, title }: { status: AdminDeviceStatus; title?: string }) {
  return (
    <Badge title={title} variant={status}>
      {status}
    </Badge>
  );
}

function OutdatedPill() {
  return <Badge variant="outdated">outdated</Badge>;
}

function UpdateBlockedPill({ reason }: { reason: string | null }) {
  return (
    <Badge
      title={reason === null ? undefined : updateBlockedReasonLabel(reason)}
      variant="update-blocked"
    >
      update blocked
    </Badge>
  );
}

function VersionCell({ row }: { row: AdminUsersData["devices"][number] }) {
  return (
    <div className="flex flex-nowrap items-center gap-2">
      <span className="font-medium">{formatVersion(row.device.version)}</span>
      {row.updateStatus === "update-blocked" ? (
        <UpdateBlockedPill reason={row.updateBlockedReason} />
      ) : row.isOutdated ? (
        <OutdatedPill />
      ) : null}
    </div>
  );
}

function StatusCell({ row, title }: { row: AdminUsersData["devices"][number]; title?: string }) {
  const repairReason = repairReasonForDevice(row.device);

  return (
    <div className="flex flex-nowrap items-center gap-2" title={title}>
      <StatusPill status={row.status} title={title} />
      {row.status === "repair-needed" && repairReason !== null ? (
        <Badge variant="repair-needed">{repairReasonLabel(repairReason)}</Badge>
      ) : null}
    </div>
  );
}

function fleetSummary(data: AdminUsersData): string {
  return [
    `${formatInteger(data.summary.healthy)} healthy`,
    `${formatInteger(data.summary.outdated)} outdated`,
    `${formatInteger(data.summary.updateBlocked)} update blocked`,
    `${formatInteger(data.summary.repairNeeded)} repair needed`,
    `${formatInteger(data.summary.stale)} stale`,
    `${formatInteger(data.summary.unknown)} unknown`,
  ].join(" · ");
}

function serviceStatusTitle(row: AdminUsersData["devices"][number]): string | undefined {
  const device = row.device;
  return [
    device.serviceBackend === null ? undefined : `backend: ${device.serviceBackend}`,
    device.serviceStatus === null ? undefined : `service: ${device.serviceStatus}`,
    device.serviceSchedulerActive === null
      ? undefined
      : `scheduler: ${device.serviceSchedulerActive ? "active" : "inactive"}`,
    device.serviceReloadRequired === null
      ? undefined
      : `reload: ${device.serviceReloadRequired ? "required" : "not required"}`,
    device.serviceRepairStatus === null
      ? undefined
      : `repair: ${device.serviceRepairStatus}${
          device.serviceRepairReason === null
            ? ""
            : ` (${repairReasonLabel(device.serviceRepairReason)})`
        }`,
    device.serviceRepairAttemptedAt === null
      ? undefined
      : `repair attempt: ${device.serviceRepairAttemptedAt}`,
    device.serviceRepairCompletedAt === null
      ? undefined
      : `repair completed: ${device.serviceRepairCompletedAt}`,
    device.serviceRepairError === null ? undefined : `repair error: ${device.serviceRepairError}`,
    device.serviceAutoUpdateStatus === null
      ? undefined
      : `auto-update: ${device.serviceAutoUpdateStatus}${
          device.serviceAutoUpdateReason === null
            ? ""
            : ` (${updateBlockedReasonLabel(device.serviceAutoUpdateReason)})`
        }`,
    device.serviceAutoUpdateManager === null
      ? undefined
      : `auto-update manager: ${device.serviceAutoUpdateManager}`,
    device.serviceAutoUpdateCurrentVersion === null
      ? undefined
      : `auto-update current: ${formatVersion(device.serviceAutoUpdateCurrentVersion)}`,
    device.serviceAutoUpdateLatestVersion === null
      ? undefined
      : `auto-update latest: ${formatVersion(device.serviceAutoUpdateLatestVersion)}`,
    device.serviceAutoUpdateInstalledVersion === null
      ? undefined
      : `auto-update installed: ${formatVersion(device.serviceAutoUpdateInstalledVersion)}`,
    device.serviceAutoUpdateError === null
      ? undefined
      : `auto-update error: ${device.serviceAutoUpdateError}`,
    repairReasonForDevice(device) === null
      ? undefined
      : "manual repair: tokenmaxxing service repair",
    device.serviceError === null ? undefined : `error: ${device.serviceError}`,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" · ");
}

function repairReasonForDevice(
  device: AdminUsersData["devices"][number]["device"] | null,
): ServiceRepairReasonValue | null {
  if (device === null) {
    return null;
  }

  if (device.serviceStatus === "failure") {
    return "service-failure";
  }
  if (device.serviceSchedulerActive === false) {
    return "scheduler-inactive";
  }
  if (device.serviceReloadRequired === true) {
    return "reload-required";
  }

  return null;
}

function updateBlockedReasonLabel(reason: string): string {
  return reason.replaceAll("-", " ");
}

function repairReasonLabel(reason: ServiceRepairReasonValue): string {
  return {
    "auto-updated": "auto updated",
    "reload-required": "reload required",
    "scheduler-inactive": "scheduler inactive",
    "service-failure": "service failure",
  }[reason];
}

function formatVersion(version: string | null): string {
  if (version === null) {
    return "unknown";
  }

  return version.startsWith("v") ? version : `v${version}`;
}

function formatDeviceSystem(device: AdminUsersData["devices"][number]["device"]): string {
  return device.arch === null ? device.platform : `${device.platform} / ${device.arch}`;
}

function formatRelativeTime(value: string | null, now: string): string {
  if (value === null) {
    return "—";
  }

  const elapsedMs = Date.parse(now) - Date.parse(value);
  if (!Number.isFinite(elapsedMs)) {
    return "—";
  }

  const minutes = Math.max(Math.floor(elapsedMs / 60_000), 0);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours}h ago`;
  }

  return `${Math.floor(hours / 24)}d ago`;
}

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function formatInteger(value: number): string {
  return integer.format(value);
}

export { Route };

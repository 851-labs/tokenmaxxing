import { Link } from "@tanstack/react-router";
import type { AdminUsersResponse } from "@tokenmaxxing/api-contract";

import {
  formatDeviceSystem,
  formatRelativeTime,
  formatVersion,
  repairReasonForDevice,
  repairReasonLabel,
  serviceStatusTitle,
  updateBlockedReasonLabel,
} from "../-lib/device-status";
import { Avatar } from "../../../../components/ui/avatar";
import { Badge } from "../../../../components/ui/badge";

type AdminUsersData = typeof AdminUsersResponse.Type;
type DeviceRow = AdminUsersData["devices"][number];

function DevicesTable({ data }: { data: AdminUsersData }) {
  const bannedUserIds = new Set(
    data.users.filter((row) => row.shadowBan !== null).map((row) => row.user.id),
  );

  return (
    <section aria-labelledby="internal-devices-title">
      <h2
        className="border-b border-border px-4 py-3 text-xs font-medium uppercase text-muted-foreground"
        id="internal-devices-title"
      >
        Devices
      </h2>
      <div className="overflow-x-auto border-b border-border">
        <table className="w-full min-w-6xl table-fixed text-left text-sm">
          <thead className="border-b border-border bg-muted/40 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="w-[18%] p-3 font-medium" scope="col">
                Machine
              </th>
              <th className="w-[15%] p-3 font-medium" scope="col">
                User
              </th>
              <th className="w-[16%] p-3 font-medium" scope="col">
                Version
              </th>
              <th
                className="hidden w-[12%] whitespace-nowrap p-3 font-medium lg:table-cell"
                scope="col"
              >
                System
              </th>
              <th className="w-[17%] p-3 font-medium" scope="col">
                Status
              </th>
              <th className="w-[12%] p-3 font-medium" scope="col">
                Last check-in
              </th>
              <th
                className="hidden w-[10%] whitespace-nowrap p-3 font-medium md:table-cell"
                scope="col"
              >
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
                  {bannedUserIds.has(row.user.id) ? (
                    <span className="flex items-center gap-2.5 font-medium">
                      <Avatar size={24} src={row.user.avatarUrl} />
                      {row.user.login}
                    </span>
                  ) : (
                    <Link
                      className="flex items-center gap-2.5 font-medium hover:underline"
                      params={{ user: row.user.login }}
                      to="/$user"
                    >
                      <Avatar size={24} src={row.user.avatarUrl} />
                      {row.user.login}
                    </Link>
                  )}
                </td>
                <td className="p-3 align-top">
                  <VersionCell row={row} />
                </td>
                <td className="hidden whitespace-nowrap p-3 align-top font-mono text-muted-foreground lg:table-cell">
                  {formatDeviceSystem(row.device)}
                </td>
                <td className="p-3 align-top">
                  <StatusCell row={row} title={serviceStatusTitle(row.device)} />
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
    </section>
  );
}

function VersionCell({ row }: { row: DeviceRow }) {
  return (
    <div className="flex flex-nowrap items-center gap-2">
      <span className="font-medium">{formatVersion(row.device.version)}</span>
      {row.updateStatus === "update-blocked" ? (
        <Badge
          title={
            row.updateBlockedReason === null
              ? undefined
              : updateBlockedReasonLabel(row.updateBlockedReason)
          }
          variant="update-blocked"
        >
          update blocked
        </Badge>
      ) : row.isOutdated ? (
        <Badge variant="outdated">outdated</Badge>
      ) : null}
    </div>
  );
}

function StatusCell({ row, title }: { row: DeviceRow; title?: string }) {
  const repairReason = repairReasonForDevice(row.device);

  return (
    <div className="flex flex-nowrap items-center gap-2" title={title}>
      <Badge title={title} variant={row.status}>
        {row.status}
      </Badge>
      {row.status === "repair-needed" && repairReason !== null ? (
        <Badge variant="repair-needed">{repairReasonLabel(repairReason)}</Badge>
      ) : null}
    </div>
  );
}

export { DevicesTable };

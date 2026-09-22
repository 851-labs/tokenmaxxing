import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";

import { DevicesTable } from "./-components/devices-table";
import { ShadowBanPanel } from "./-components/shadow-ban-panel";
import { isApiError } from "../../../lib/api";
import { fleetSummary, formatVersion } from "../../../lib/device-status";
import { formatInteger } from "../../../lib/format";
import { adminUsersQueryOptions } from "../../../lib/queries";
import { pageHead } from "../../../lib/seo";

const Route = createFileRoute("/_authed/internal")({
  loader: async ({ context }) => {
    try {
      await context.queryClient.ensureQueryData(adminUsersQueryOptions);
    } catch (error) {
      // Signed-in non-admins get the same 404 as a missing page.
      if (isApiError(error, "Forbidden")) {
        throw notFound();
      }

      throw error;
    }
  },
  head: () => pageHead({ noindex: true, path: "/internal", title: "Internal — tokenmaxxing.sh" }),
  component: InternalPage,
});

function InternalPage() {
  const { data } = useSuspenseQuery(adminUsersQueryOptions);

  return (
    <>
      <header className="px-4 py-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Internal</h1>
          <p className="mt-1 text-sm text-muted-foreground">{fleetSummary(data.summary)}</p>
        </div>
      </header>
      <dl className="grid gap-px border-y border-border bg-border text-sm sm:grid-cols-3">
        <SummaryCell label="Latest CLI" value={formatVersion(data.latestCliVersion)} />
        <SummaryCell label="Users" value={formatInteger(data.summary.totalUsers)} />
        <SummaryCell label="Devices" value={formatInteger(data.summary.totalDevices)} />
      </dl>
      <ShadowBanPanel users={data.users} />
      <DevicesTable data={data} />
    </>
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

export { Route };

import { Link } from "@tanstack/react-router";
import type { LeaderboardResponse } from "@tokenmaxxing/api-contract";

import { formatTokens, formatUsd } from "../../lib/format";
import { Avatar } from "../ui/avatar";

type LeaderboardEntry = (typeof LeaderboardResponse.Type)["entries"][number];

function LeaderboardTable({ entries }: { entries: readonly LeaderboardEntry[] }) {
  return (
    <div className="overflow-hidden border-y border-border">
      {entries.length === 0 ? (
        <p className="p-6 text-sm text-muted-foreground">
          Nobody on the board yet — be the first to sync.
        </p>
      ) : (
        <table className="w-full text-sm">
          <caption className="sr-only">
            Leaderboard of top users by LLM token spend and usage
          </caption>
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left text-xs uppercase tracking-wider text-muted-foreground">
              <th className="w-12 p-3 font-medium" scope="col">
                #
              </th>
              <th className="p-3 font-medium" scope="col">
                User
              </th>
              <th className="p-3 text-right font-medium" scope="col">
                Spend
              </th>
              <th className="p-3 text-right font-medium" scope="col">
                Tokens
              </th>
              <th className="hidden p-3 text-right font-medium sm:table-cell" scope="col">
                Active days
              </th>
              <th className="hidden p-3 text-right font-medium sm:table-cell" scope="col">
                Last active
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr
                className="border-b border-border transition-colors last:border-b-0 hover:bg-muted/40"
                key={entry.user.id}
              >
                <td className="p-3 font-mono text-muted-foreground">{entry.rank}</td>
                <td className="p-3">
                  <Link
                    className="flex items-center gap-2.5 font-medium hover:underline"
                    params={{ user: entry.user.login }}
                    to="/$user"
                  >
                    <Avatar
                      alt={`${entry.user.login} avatar`}
                      size={24}
                      src={entry.user.avatarUrl}
                    />
                    {entry.user.login}
                  </Link>
                </td>
                <td className="p-3 text-right font-mono tabular-nums">
                  {formatUsd(entry.spendUsd)}
                </td>
                <td className="p-3 text-right font-mono tabular-nums">
                  {formatTokens(entry.totalTokens)}
                </td>
                <td className="hidden p-3 text-right tabular-nums text-muted-foreground sm:table-cell">
                  {entry.activeDays}
                </td>
                <td className="hidden p-3 text-right text-muted-foreground sm:table-cell">
                  {entry.lastDate ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export { LeaderboardTable };

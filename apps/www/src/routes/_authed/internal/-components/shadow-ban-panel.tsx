import { useId, useState, type KeyboardEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AdminUsersResponse } from "@tokenmaxxing/api-contract";

import { errorMessage, runApi } from "../../../../lib/api";
import { formatInteger, formatUsd } from "../../../../lib/format";
import { invalidatePublicViews, queryKeys } from "../../../../lib/queries";
import { LocalDateTime } from "../../../../components/local-date-time";
import { Avatar } from "../../../../components/ui/avatar";
import { Badge } from "../../../../components/ui/badge";
import { Button } from "../../../../components/ui/button";
import { ErrorText } from "../../../../components/ui/error-text";
import { Input } from "../../../../components/ui/input";

type AdminUsersData = typeof AdminUsersResponse.Type;
type UserRow = AdminUsersData["users"][number];

const MAX_MATCHES = 8;

/** Shadow-banned users, plus the form to ban another. */
function ShadowBanPanel({ users }: { users: AdminUsersData["users"] }) {
  const [adding, setAdding] = useState(false);
  const bannedUsers = users.filter((row) => row.shadowBan !== null);

  return (
    <section aria-labelledby="internal-shadow-bans-title">
      <div className="flex items-center justify-between gap-4 border-b border-border px-4 py-3">
        <h2
          className="text-xs font-medium uppercase text-muted-foreground"
          id="internal-shadow-bans-title"
        >
          Shadow banned users ({formatInteger(bannedUsers.length)})
        </h2>
        <Button
          aria-expanded={adding}
          onClick={() => setAdding((open) => !open)}
          size="xs"
          variant="outline"
        >
          {adding ? "Close" : "Shadow ban user"}
        </Button>
      </div>
      {adding ? <ShadowBanUserForm onClose={() => setAdding(false)} users={users} /> : null}
      <div className="overflow-x-auto border-b border-border">
        <table className="w-full min-w-216 table-fixed text-left text-sm">
          <thead className="border-b border-border bg-muted/40 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="w-[25%] p-3 font-medium" scope="col">
                User
              </th>
              <th className="w-[25%] p-3 font-medium" scope="col">
                Usage
              </th>
              <th className="w-[18%] p-3 font-medium" scope="col">
                Last activity
              </th>
              <th className="w-[32%] p-3 font-medium" scope="col">
                Visibility
              </th>
            </tr>
          </thead>
          <tbody>
            {bannedUsers.map((row) => (
              <tr className="border-b border-border last:border-b-0" key={row.user.id}>
                <td className="p-3 align-top">
                  <span className="flex items-center gap-2.5 font-medium">
                    <Avatar size={24} src={row.user.avatarUrl} />
                    {row.user.login}
                  </span>
                </td>
                <td className="p-3 align-top">
                  <div>{formatInteger(row.totalTokens)} tokens</div>
                  <div className="mt-1 font-mono text-xs text-muted-foreground">
                    {formatUsd(row.totalSpendUsd)} · {formatInteger(row.activeDays)} days
                  </div>
                </td>
                <td className="p-3 align-top font-mono text-xs text-muted-foreground">
                  {row.lastUsageDate ?? "—"}
                </td>
                <td className="p-3 align-top">
                  <ModerationCell allUsers={users} row={row} />
                </td>
              </tr>
            ))}
            {bannedUsers.length === 0 ? (
              <tr>
                <td className="p-6 text-center text-muted-foreground" colSpan={4}>
                  No users are shadow banned.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ShadowBanUserForm({
  onClose,
  users,
}: {
  onClose: () => void;
  users: AdminUsersData["users"];
}) {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const eligibleUsers = users.filter((row) => row.shadowBan === null);
  const selectedUser = eligibleUsers.find((row) => row.user.id === selectedUserId) ?? null;
  const ban = useMutation({
    mutationFn: (row: UserRow) =>
      runApi((client) => client.admin.shadowBanUser({ params: { userId: row.user.id } })),
    onSuccess: async (_result, row) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.adminUsers }),
        invalidatePublicViews(queryClient, row.user.login),
      ]);
      onClose();
    },
  });

  return (
    <div className="border-b border-border bg-muted/20 px-4 py-4">
      <div className="max-w-xl space-y-3">
        <UserSearch
          onQueryChange={(next) => {
            setQuery(next);
            setSelectedUserId(null);
          }}
          onSelect={(row) => {
            setQuery(row.user.login);
            setSelectedUserId(row.user.id);
          }}
          query={query}
          selected={selectedUser !== null}
          users={eligibleUsers}
        />
        {selectedUser === null ? null : (
          <div className="flex items-center gap-2 text-sm">
            <Avatar size={24} src={selectedUser.user.avatarUrl} />
            <span>
              Shadow ban <strong>{selectedUser.user.login}</strong>
            </span>
          </div>
        )}
        <div className="flex items-center gap-2">
          <Button
            disabled={selectedUser === null || ban.isPending}
            onClick={() => {
              if (selectedUser !== null) {
                ban.mutate(selectedUser);
              }
            }}
            size="sm"
            variant="destructive"
          >
            {ban.isPending ? "Banning…" : "Shadow ban user"}
          </Button>
          <Button disabled={ban.isPending} onClick={onClose} size="sm" variant="ghost">
            Cancel
          </Button>
        </div>
        {ban.error === null ? null : (
          <ErrorText className="text-xs">
            {errorMessage(ban.error, "Could not shadow ban this user.")}
          </ErrorText>
        )}
      </div>
    </div>
  );
}

/**
 * Username search as an ARIA combobox: typing filters the listbox, ↑/↓ move
 * the active option (focus stays in the input), Enter picks it, and Escape
 * clears the query.
 */
function UserSearch({
  onQueryChange,
  onSelect,
  query,
  selected,
  users,
}: {
  onQueryChange: (query: string) => void;
  onSelect: (row: UserRow) => void;
  query: string;
  selected: boolean;
  users: readonly UserRow[];
}) {
  const id = useId();
  const inputId = `${id}-input`;
  const listboxId = `${id}-listbox`;
  const [activeIndex, setActiveIndex] = useState(0);
  const normalizedQuery = query.trim().toLowerCase();
  const matches =
    normalizedQuery.length === 0
      ? []
      : users
          .filter((row) => row.user.login.toLowerCase().includes(normalizedQuery))
          .slice(0, MAX_MATCHES);
  const open = !selected && normalizedQuery.length > 0;
  const active = open ? matches[activeIndex] : undefined;
  const optionId = (row: UserRow) => `${id}-option-${row.user.id}`;

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (matches.length === 0) {
        return;
      }
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((index) => (index + step + matches.length) % matches.length);
    } else if (event.key === "Enter" && active !== undefined) {
      event.preventDefault();
      onSelect(active);
    } else if (event.key === "Escape" && query.length > 0) {
      event.preventDefault();
      onQueryChange("");
    }
  };

  return (
    <div>
      <label className="text-xs font-medium uppercase text-muted-foreground" htmlFor={inputId}>
        User
      </label>
      <Input
        aria-activedescendant={active === undefined ? undefined : optionId(active)}
        aria-autocomplete="list"
        aria-controls={listboxId}
        aria-expanded={open}
        autoComplete="off"
        className="mt-1 w-full"
        id={inputId}
        onChange={(event) => {
          onQueryChange(event.target.value);
          setActiveIndex(0);
        }}
        onKeyDown={onKeyDown}
        placeholder="Search by username"
        role="combobox"
        value={query}
      />
      {open ? (
        <div className="mt-1 max-h-52 overflow-y-auto border border-border bg-background">
          <ul aria-label="Matching users" id={listboxId} role="listbox">
            {matches.map((row, index) => (
              <li
                aria-selected={index === activeIndex}
                className="flex w-full cursor-pointer items-center gap-2 border-b border-border px-3 py-2 text-left text-sm last:border-b-0 hover:bg-muted aria-selected:bg-muted"
                id={optionId(row)}
                key={row.user.id}
                // Keep focus in the input so the combobox stays in control.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onSelect(row)}
                onPointerEnter={() => setActiveIndex(index)}
                role="option"
              >
                <Avatar size={24} src={row.user.avatarUrl} />
                <span className="font-medium">{row.user.login}</span>
              </li>
            ))}
          </ul>
          {matches.length === 0 ? (
            <p className="px-3 py-2 text-sm text-muted-foreground" role="status">
              No matching users.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ModerationCell({ allUsers, row }: { allUsers: AdminUsersData["users"]; row: UserRow }) {
  const queryClient = useQueryClient();
  const unban = useMutation({
    mutationFn: () =>
      runApi((client) => client.admin.shadowUnbanUser({ params: { userId: row.user.id } })),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.adminUsers }),
        invalidatePublicViews(queryClient, row.user.login),
      ]);
    },
  });

  if (row.shadowBan === null) {
    return null;
  }

  const actor = allUsers.find((candidate) => candidate.user.id === row.shadowBan?.byUserId);
  return (
    <div>
      <div className="flex items-center gap-2">
        <Badge variant="repair-needed">shadow banned</Badge>
        <Button
          aria-label={`Unban ${row.user.login}`}
          disabled={unban.isPending}
          onClick={() => {
            if (window.confirm(`Restore public visibility for ${row.user.login}?`)) {
              unban.mutate();
            }
          }}
          size="xs"
          variant="outline"
        >
          {unban.isPending ? "Restoring…" : "Unban"}
        </Button>
      </div>
      <p className="mt-2 font-mono text-xs text-muted-foreground">
        <LocalDateTime iso={row.shadowBan.at} /> · by {actor?.user.login ?? row.shadowBan.byUserId}
      </p>
      {unban.error === null ? null : (
        <ErrorText className="mt-2 text-xs">
          {errorMessage(unban.error, "Could not restore public visibility.")}
        </ErrorText>
      )}
    </div>
  );
}

export { ShadowBanPanel };

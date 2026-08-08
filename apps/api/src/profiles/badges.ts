import { Context, Effect } from "effect";

import type { ProfileBadgeId } from "@tokenmaxxing/api-contract";

import { AppConfig } from "../config";

const REPOSITORY = "851-labs/tokenmaxxing";
const OWNER_LOGIN = "pondorasti";
const SNAPSHOT_TTL_MS = 15 * 60 * 1000;
const FAILED_SNAPSHOT_TTL_MS = 60 * 1000;
const MAX_PAGES = 10;

interface BadgeSnapshot {
  contributors: ReadonlySet<string>;
  expiresAt: number;
}

interface ProfileBadgesShape {
  resolve(identity: GitHubBadgeIdentity | null): Effect.Effect<ProfileBadgeId[]>;
}

interface GitHubBadgeIdentity {
  login: string;
  starredTokenmaxxing: boolean;
}

interface ProfileBadgeResolverOptions {
  discordGithubLogins: readonly string[];
  fetch: FetchRequest;
  githubClientId: string;
  githubClientSecret: string;
  now?: () => number;
}

type FetchRequest = (input: string | URL, init?: RequestInit) => Promise<Response>;

class ProfileBadges extends Context.Service<ProfileBadges, ProfileBadgesShape>()(
  "@tokenmaxxing/api/ProfileBadges",
) {}

function makeProfileBadgeResolver(options: ProfileBadgeResolverOptions) {
  const now = options.now ?? Date.now;
  const discordGithubLogins = new Set(options.discordGithubLogins.map(normalizeLogin));
  const headers = githubHeaders(options.githubClientId, options.githubClientSecret);
  let snapshot: BadgeSnapshot | null = null;
  let snapshotPromise: Promise<BadgeSnapshot> | null = null;

  return async function resolveProfileBadges(
    identity: GitHubBadgeIdentity | null,
  ): Promise<ProfileBadgeId[]> {
    if (identity === null) {
      return [];
    }

    const login = normalizeLogin(identity.login);
    const current = await loadSnapshot();
    const badges: ProfileBadgeId[] = [];

    if (login === OWNER_LOGIN) {
      badges.push("owner");
    }
    if (current.contributors.has(login)) {
      badges.push("contributor");
    }
    if (identity.starredTokenmaxxing) {
      badges.push("starred");
    }
    if (discordGithubLogins.has(login)) {
      badges.push("discord");
    }

    return badges;
  };

  async function loadSnapshot(): Promise<BadgeSnapshot> {
    if (snapshot !== null && snapshot.expiresAt > now()) {
      return snapshot;
    }
    if (snapshotPromise !== null) {
      return snapshotPromise;
    }

    snapshotPromise = refreshSnapshot(snapshot).finally(() => {
      snapshotPromise = null;
    });
    snapshot = await snapshotPromise;
    return snapshot;
  }

  async function refreshSnapshot(previous: BadgeSnapshot | null): Promise<BadgeSnapshot> {
    const contributors = await fetchLoginSet(
      `https://api.github.com/repos/${REPOSITORY}/contributors`,
      options.fetch,
      headers,
    ).then(
      (value) => ({ ok: true, value }),
      () => ({ ok: false, value: previous?.contributors ?? new Set<string>() }),
    );
    const ttl = contributors.ok ? SNAPSHOT_TTL_MS : FAILED_SNAPSHOT_TTL_MS;

    return {
      contributors: contributors.value,
      expiresAt: now() + ttl,
    };
  }
}

const makeProfileBadges = Effect.fn("makeProfileBadges")(function* () {
  const config = yield* AppConfig;
  const resolve = makeProfileBadgeResolver({
    discordGithubLogins: config.discordGithubLogins,
    fetch: globalThis.fetch,
    githubClientId: config.github.clientId,
    githubClientSecret: config.github.clientSecret,
  });

  return ProfileBadges.of({
    resolve: (identity) => Effect.promise(() => resolve(identity)),
  });
});

async function fetchLoginSet(
  endpoint: string,
  fetchRequest: FetchRequest,
  headers: HeadersInit,
): Promise<ReadonlySet<string>> {
  const logins = new Set<string>();

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = new URL(endpoint);
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", "100");
    const response = await fetchRequest(url, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      throw new Error(`GitHub responded ${response.status} for ${url.pathname}`);
    }

    const payload = (await response.json()) as unknown;
    if (!Array.isArray(payload)) {
      throw new Error(`GitHub returned an invalid list for ${url.pathname}`);
    }

    for (const entry of payload) {
      if (isGitHubLogin(entry)) {
        logins.add(normalizeLogin(entry.login));
      }
    }
    if (payload.length < 100) {
      break;
    }
  }

  return logins;
}

function isGitHubLogin(value: unknown): value is { login: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "login" in value &&
    typeof value.login === "string"
  );
}

function githubHeaders(clientId: string, clientSecret: string): HeadersInit {
  return {
    accept: "application/vnd.github+json",
    authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
    "user-agent": "tokenmaxxing",
    "x-github-api-version": "2022-11-28",
  };
}

function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

export { makeProfileBadgeResolver, makeProfileBadges, ProfileBadges };

export type { FetchRequest, GitHubBadgeIdentity, ProfileBadgesShape };

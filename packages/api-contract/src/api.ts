import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";

import {
  AdminUserNotFound,
  DeviceNotFound,
  DeviceMissing,
  Forbidden,
  LoginCodeExpired,
  LoginCodeNotFound,
  TokenNotFound,
  UserNotFound,
} from "./errors";
import { Authorization, CliAuth } from "./middleware";
import {
  AdminUsersResponse,
  CliLoginApproveInput,
  CliLoginApproveResponse,
  CliLoginPollInput,
  CliLoginPollResponse,
  CliLoginStartInput,
  CliLoginStartResponse,
  CliTokenSummary,
  DeviceSummary,
  HealthResponse,
  IngestUsageInput,
  LeaderboardMetric,
  LeaderboardResponse,
  LeaderboardWindow,
  MeResponse,
  OkResponse,
  ProfileDailyGroupBy,
  ProfileDailyResponse,
  ProfileResponse,
  ShadowBanUserResponse,
  StatsResponse,
  UsageCheckInInput,
  UsageCheckInResponse,
  SyncUsageInput,
  SyncUsageResponse,
  UserAccountSummary,
} from "./schemas";

/**
 * The whole HTTP contract, one group per domain. Authorization guards the
 * session-cookie surface (www), CliAuth guards the bearer-token surface
 * (CLI), and leaderboard/profiles stay public. The OAuth browser flow
 * (redirects + Set-Cookie) lives in raw router routes, not here.
 */

class HealthGroup extends HttpApiGroup.make("health").add(
  HttpApiEndpoint.get("status", "/health", {
    success: HealthResponse,
  }),
) {}

class MeGroup extends HttpApiGroup.make("me")
  .add(
    HttpApiEndpoint.get("me", "/me", {
      success: MeResponse,
    }),
  )
  .add(
    HttpApiEndpoint.get("listAccounts", "/me/accounts", {
      success: Schema.Struct({ accounts: Schema.Array(UserAccountSummary) }),
    }),
  )
  .add(
    HttpApiEndpoint.post("approveCliLogin", "/cli/login/approve", {
      payload: CliLoginApproveInput,
      success: CliLoginApproveResponse,
      error: [LoginCodeNotFound, LoginCodeExpired],
    }),
  )
  .add(
    HttpApiEndpoint.get("listDevices", "/me/devices", {
      success: Schema.Struct({ devices: Schema.Array(DeviceSummary) }),
    }),
  )
  .add(
    HttpApiEndpoint.post("deleteDevice", "/me/devices/:deviceId/delete", {
      params: {
        deviceId: Schema.String,
      },
      success: OkResponse,
      error: DeviceNotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get("listTokens", "/me/tokens", {
      success: Schema.Struct({ tokens: Schema.Array(CliTokenSummary) }),
    }),
  )
  .add(
    HttpApiEndpoint.post("revokeToken", "/me/tokens/:tokenId/revoke", {
      params: {
        tokenId: Schema.String,
      },
      success: OkResponse,
      error: TokenNotFound,
    }),
  )
  .middleware(Authorization) {}

class CliLoginGroup extends HttpApiGroup.make("cliLogin")
  .add(
    HttpApiEndpoint.post("start", "/cli/login/start", {
      payload: CliLoginStartInput,
      success: CliLoginStartResponse,
    }),
  )
  .add(
    HttpApiEndpoint.post("poll", "/cli/login/poll", {
      payload: CliLoginPollInput,
      success: CliLoginPollResponse,
      error: [LoginCodeNotFound, LoginCodeExpired],
    }),
  ) {}

class UsageGroup extends HttpApiGroup.make("usage")
  .add(
    HttpApiEndpoint.post("checkIn", "/usage/check-in", {
      payload: UsageCheckInInput,
      success: UsageCheckInResponse,
      error: DeviceMissing,
    }),
  )
  .add(
    HttpApiEndpoint.post("ingest", "/usage/ingest", {
      payload: IngestUsageInput,
      success: SyncUsageResponse,
      error: DeviceMissing,
    }),
  )
  .add(
    // Legacy structured sync for old CLI clients. New clients send normalized
    // daily ccusage reports and aggregate source stats to /usage/ingest.
    HttpApiEndpoint.post("sync", "/usage/sync", {
      payload: SyncUsageInput,
      success: SyncUsageResponse,
      error: DeviceMissing,
    }),
  )
  .add(
    HttpApiEndpoint.post("logout", "/cli/logout", {
      success: OkResponse,
    }),
  )
  .middleware(CliAuth) {}

class LeaderboardGroup extends HttpApiGroup.make("leaderboard").add(
  HttpApiEndpoint.get("list", "/leaderboard", {
    query: {
      metric: Schema.optional(LeaderboardMetric),
      window: Schema.optional(LeaderboardWindow),
    },
    success: LeaderboardResponse,
  }),
) {}

class StatsGroup extends HttpApiGroup.make("stats").add(
  HttpApiEndpoint.get("get", "/stats", {
    success: StatsResponse,
  }),
) {}

class ProfilesGroup extends HttpApiGroup.make("profiles")
  .add(
    HttpApiEndpoint.get("get", "/profiles/:login", {
      params: {
        login: Schema.String,
      },
      success: ProfileResponse,
      error: UserNotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get("daily", "/profiles/:login/daily", {
      params: {
        login: Schema.String,
      },
      query: {
        groupBy: Schema.optional(ProfileDailyGroupBy),
        since: Schema.optional(Schema.String),
        until: Schema.optional(Schema.String),
      },
      success: ProfileDailyResponse,
      error: UserNotFound,
    }),
  ) {}

class AdminGroup extends HttpApiGroup.make("admin")
  .add(
    HttpApiEndpoint.get("listUsers", "/admin/users", {
      success: AdminUsersResponse,
      error: Forbidden,
    }),
  )
  .add(
    HttpApiEndpoint.post("shadowBanUser", "/admin/users/:userId/shadow-ban", {
      params: {
        userId: Schema.String,
      },
      success: ShadowBanUserResponse,
      error: [Forbidden, AdminUserNotFound],
    }),
  )
  .add(
    HttpApiEndpoint.post("shadowUnbanUser", "/admin/users/:userId/shadow-unban", {
      params: {
        userId: Schema.String,
      },
      success: ShadowBanUserResponse,
      error: [Forbidden, AdminUserNotFound],
    }),
  )
  .middleware(Authorization) {}

class TokenmaxxingApi extends HttpApi.make("tokenmaxxing")
  .add(HealthGroup)
  .add(MeGroup)
  .add(CliLoginGroup)
  .add(UsageGroup)
  .add(LeaderboardGroup)
  .add(StatsGroup)
  .add(ProfilesGroup)
  .add(AdminGroup) {}

export {
  AdminGroup,
  CliLoginGroup,
  HealthGroup,
  LeaderboardGroup,
  MeGroup,
  ProfilesGroup,
  StatsGroup,
  TokenmaxxingApi,
  UsageGroup,
};

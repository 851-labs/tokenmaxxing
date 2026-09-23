import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";

import { DateKey } from "./date-key";
import {
  AdminUserNotFound,
  BadRequest,
  CliUpgradeRequired,
  DeviceNotFound,
  Forbidden,
  LoginCodeExpired,
  LoginCodeNotFound,
  RouteNotFound,
  TokenDeviceUnbound,
  TokenNotFound,
  UserNotFound,
} from "./errors";
import { AllowCliToken, Authorization, CliAuth, ErrorBoundary } from "./middleware";
import {
  AdminUsersResponse,
  CliLoginApproveInput,
  CliLoginApproveResponse,
  CliLoginPollInput,
  CliLoginPollResponse,
  CliLoginRequestSummary,
  CliLoginStartInput,
  CliLoginStartResponse,
  DeviceId,
  HealthResponse,
  IngestUsageInput,
  LeaderboardMetric,
  LeaderboardResponse,
  LeaderboardWindow,
  ListAccountsResponse,
  ListDevicesResponse,
  ListTokensResponse,
  MeResponse,
  OkResponse,
  ProfileDailyGroupBy,
  ProfileDailyResponse,
  ProfileIdentityResponse,
  ProfileResponse,
  ShadowBanUserResponse,
  StatsResponse,
  UsageCheckInInput,
  UsageCheckInResponse,
  SyncUsageInput,
  SyncUsageResponse,
  TokenId,
  UserId,
} from "./schemas";

/**
 * The whole HTTP contract, one group per domain. Authorization guards the
 * session-cookie surface (www), CliAuth guards the bearer-token surface
 * (CLI), and leaderboard/profiles stay public. ErrorBoundary wraps every
 * endpoint (added last, so it is outermost). The OAuth browser flow
 * (redirects + Set-Cookie) lives in raw router routes, not here.
 */

class HealthGroup extends HttpApiGroup.make("health").add(
  HttpApiEndpoint.get("status", "/health", {
    success: HealthResponse,
  }),
) {}

class MeGroup extends HttpApiGroup.make("me")
  .add(
    // The CLI's whoami/auth check; the only session endpoint a CLI token may call.
    HttpApiEndpoint.get("me", "/me", {
      success: MeResponse,
    }).annotate(AllowCliToken, true),
  )
  .add(
    HttpApiEndpoint.get("listAccounts", "/me/accounts", {
      success: ListAccountsResponse,
    }),
  )
  .add(
    HttpApiEndpoint.get("describeCliLogin", "/cli/login/request", {
      query: {
        code: Schema.String,
      },
      success: CliLoginRequestSummary,
      error: [LoginCodeNotFound, LoginCodeExpired],
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
      success: ListDevicesResponse,
    }),
  )
  .add(
    HttpApiEndpoint.post("deleteDevice", "/me/devices/:deviceId/delete", {
      params: {
        deviceId: DeviceId,
      },
      success: OkResponse,
      error: DeviceNotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get("listTokens", "/me/tokens", {
      success: ListTokensResponse,
    }),
  )
  .add(
    HttpApiEndpoint.post("revokeToken", "/me/tokens/:tokenId/revoke", {
      params: {
        tokenId: TokenId,
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
      error: CliUpgradeRequired,
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
      error: TokenDeviceUnbound,
    }),
  )
  .add(
    HttpApiEndpoint.post("ingest", "/usage/ingest", {
      payload: IngestUsageInput,
      success: SyncUsageResponse,
      error: TokenDeviceUnbound,
    }),
  )
  .add(
    // Legacy structured sync for old CLI clients. New clients send normalized
    // daily ccusage reports and aggregate source stats to /usage/ingest.
    HttpApiEndpoint.post("sync", "/usage/sync", {
      payload: SyncUsageInput,
      success: SyncUsageResponse,
      error: TokenDeviceUnbound,
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

/**
 * `:login` comes straight from a profile URL. The router caps path params at
 * 100 characters and answers longer ones with RouteNotFound before any
 * handler runs, so each profile read declares it next to UserNotFound; an
 * undeclared tag would not decode into a typed error on the client.
 */
class ProfilesGroup extends HttpApiGroup.make("profiles")
  .add(
    HttpApiEndpoint.get("list", "/profiles", {
      success: Schema.Array(ProfileIdentityResponse),
    }),
  )
  .add(
    HttpApiEndpoint.get("identity", "/profiles/:login/identity", {
      params: {
        login: Schema.String,
      },
      success: ProfileIdentityResponse,
      error: [UserNotFound, RouteNotFound],
    }),
  )
  .add(
    HttpApiEndpoint.get("get", "/profiles/:login", {
      params: {
        login: Schema.String,
      },
      success: ProfileResponse,
      error: [UserNotFound, RouteNotFound],
    }),
  )
  .add(
    HttpApiEndpoint.get("daily", "/profiles/:login/daily", {
      params: {
        login: Schema.String,
      },
      query: {
        groupBy: Schema.optional(ProfileDailyGroupBy),
        since: Schema.optional(DateKey),
        until: Schema.optional(DateKey),
      },
      success: ProfileDailyResponse,
      // BadRequest: `since` after the (ceiling-capped) `until`.
      error: [UserNotFound, RouteNotFound, BadRequest],
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
        userId: UserId,
      },
      success: ShadowBanUserResponse,
      error: [Forbidden, AdminUserNotFound],
    }),
  )
  .add(
    HttpApiEndpoint.post("shadowUnbanUser", "/admin/users/:userId/shadow-unban", {
      params: {
        userId: UserId,
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
  .add(AdminGroup)
  .middleware(ErrorBoundary) {}

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

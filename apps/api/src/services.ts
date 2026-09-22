import { Layer } from "effect";

import { AdminServiceLive } from "./admin/d1";
import { AuthServiceLive } from "./auth/d1";
import { CleanupServiceLive } from "./cleanup/d1";
import { CliLoginServiceLive } from "./clilogin/d1";
import { LeaderboardServiceLive } from "./leaderboard/d1";
import { OAuthProvidersLive } from "./oauth/registry";
import { ProfilesServiceLive } from "./profiles/d1";
import { StatsServiceLive } from "./stats/d1";
import { TokensServiceLive } from "./tokens/d1";
import { UsageServiceLive } from "./usage/d1";

/**
 * Every domain service, each wired to its D1 repository. What remains to
 * provide is infrastructure: AppConfig, Drizzle, and the raw usage store.
 */
const ServicesLive = Layer.mergeAll(
  AdminServiceLive,
  AuthServiceLive,
  CleanupServiceLive,
  CliLoginServiceLive,
  LeaderboardServiceLive,
  OAuthProvidersLive,
  ProfilesServiceLive,
  StatsServiceLive,
  TokensServiceLive,
  UsageServiceLive,
);

export { ServicesLive };

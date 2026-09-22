import { Context, Effect } from "effect";
import * as Config from "effect/Config";
import * as Redacted from "effect/Redacted";

const productName = "Tokenmaxxing";
const apiWorkerName = "tokenmaxxing-api";

/** Where one environment lives; cookie attributes and redirect targets derive from it. */
interface Deployment {
  apiOrigin: string;
  cookieDomain: string;
  secure: boolean;
  wwwOrigin: string;
}

const deployments = {
  development: {
    apiOrigin: "http://api.tokenmaxxing.localhost:8788",
    cookieDomain: ".tokenmaxxing.localhost",
    secure: false,
    wwwOrigin: "http://tokenmaxxing.localhost:3002",
  },
  production: {
    apiOrigin: "https://api.tokenmaxxing.sh",
    cookieDomain: ".tokenmaxxing.sh",
    secure: true,
    wwwOrigin: "https://tokenmaxxing.sh",
  },
} as const satisfies Record<"development" | "production", Deployment>;

/**
 * One deploy serves dev (api.tokenmaxxing.localhost, http) and prod
 * (api.tokenmaxxing.sh, https); the request host picks which. The local dev
 * provider proxies with a rewritten Host (127.0.0.1:port), so any
 * loopback-ish host means dev.
 */
function deploymentForHost(host: string): Deployment {
  const hostname = host.split(":")[0] ?? host;
  const isDev =
    hostname.endsWith(".tokenmaxxing.localhost") ||
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1";

  return isDev ? deployments.development : deployments.production;
}

interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
}

interface AppConfigShape {
  apiWorkerName: string;
  corsOrigins: string[];
  github: OAuthClientConfig;
  google: OAuthClientConfig;
  productName: string;
}

/**
 * The worker's complete configuration, resolved once per invocation in the
 * worker's OUTER Effect.gen — alchemy discovers the Config.* reads there and
 * binds them as deploy-time secrets — and provided as a plain Layer.succeed
 * everywhere else.
 */
class AppConfig extends Context.Service<AppConfig, AppConfigShape>()(
  "@tokenmaxxing/api/AppConfig",
) {
  /** Secrets resolve from .env at deploy time and bind as secret_text. */
  static readonly fromEnv = Effect.gen(function* () {
    const githubClientId = yield* Config.String("GITHUB_CLIENT_ID");
    const githubClientSecret = yield* Config.Redacted("GITHUB_CLIENT_SECRET");
    const googleClientId = yield* Config.String("GOOGLE_CLIENT_ID");
    const googleClientSecret = yield* Config.Redacted("GOOGLE_CLIENT_SECRET");

    return AppConfig.of({
      apiWorkerName,
      // Local dev always passes browser CORS, regardless of the serving host.
      corsOrigins: [deployments.production.wwwOrigin, deployments.development.wwwOrigin],
      github: {
        clientId: githubClientId,
        clientSecret: Redacted.value(githubClientSecret),
      },
      google: {
        clientId: googleClientId,
        clientSecret: Redacted.value(googleClientSecret),
      },
      productName,
    });
  });
}

export { AppConfig, deploymentForHost };

export type { AppConfigShape, Deployment };

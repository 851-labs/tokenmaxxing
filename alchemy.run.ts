import { localState, Stack } from "alchemy";
import { adopt } from "alchemy/AdoptPolicy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import { Bucket } from "./apps/api/src/cloudflare/bucket";
import { Database } from "./apps/api/src/cloudflare/database";
import ApiWorker from "./apps/api/src/worker";

const stack = Stack(
  "tokenmaxxing",
  {
    providers: Cloudflare.providers(),
    // Deploys (local `bun run deploy` and CI) share remote state on the
    // Cloudflare state-store worker; `bun run dev` stays machine-local.
    state: process.env["ALCHEMY_STATE"] === "cloudflare" ? Cloudflare.state() : localState(),
  },
  Effect.gen(function* () {
    const api = yield* ApiWorker;
    const bucket = yield* Bucket;
    const db = yield* Database;

    const www = yield* Cloudflare.Vite("www", {
      name: "tokenmaxxing-www",
      rootDir: "./apps/www",
      url: false,
      compatibility: {
        date: "2026-06-02",
        flags: ["nodejs_compat"],
      },
      domain: "tokenmaxxing.sh",
      observability: {
        enabled: true,
      },
      env: {
        BROWSER: Cloudflare.Browser(),
        BUCKET: bucket,
      },
      dev: {
        host: "tokenmaxxing.localhost",
        port: 3002,
        strictPort: true,
      },
    });

    // Force HTTPS on the apex zone. Cloudflare exposes this as the
    // `always_use_https` zone setting, but the installed alchemy version has no
    // `ZoneSetting` resource — the supported way to express it is a dynamic
    // redirect rule in the `http_request_dynamic_redirect` phase that rewrites
    // every non-TLS request to its `https://` equivalent with a 301.
    //
    // The zone already exists in Cloudflare (created out-of-band), so adopt it
    // rather than provisioning a new one. Zones default to retain-on-removal.
    const zone = yield* Cloudflare.Zone("tokenmaxxing-sh", {
      name: "tokenmaxxing.sh",
    }).pipe(adopt(true));

    const httpsRedirect = yield* Cloudflare.Ruleset("always-use-https", {
      zone,
      phase: "http_request_dynamic_redirect",
      description: "Always redirect HTTP to HTTPS",
      rules: [
        {
          description: "Redirect all HTTP requests to HTTPS",
          expression: "not ssl",
          action: "redirect",
          actionParameters: {
            fromValue: {
              targetUrl: {
                expression: 'concat("https://", http.host, http.request.uri.path)',
              },
              preserveQueryString: true,
              statusCode: "301",
            },
          },
        },
      ],
    });

    return {
      api,
      bucket,
      db,
      www,
      zone,
      httpsRedirect,
    };
  }),
);

export default stack;

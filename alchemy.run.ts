import { localState, Stack } from "alchemy";
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

    const www = yield* Cloudflare.Website.Vite("www", {
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

    return {
      api,
      bucket,
      db,
      www,
    };
  }),
);

export default stack;

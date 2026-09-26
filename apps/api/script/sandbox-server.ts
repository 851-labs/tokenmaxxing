#!/usr/bin/env bun
/**
 * Local API sandbox: the real API (router, middleware, services, D1
 * repositories) served over HTTP on 127.0.0.1, backed by an in-memory
 * node:sqlite database migrated with the real packages/db migrations and an
 * in-memory R2 stand-in. OAuth is disabled; users and CLI tokens are minted
 * through the sandbox control routes. Nothing here talks to Cloudflare or any
 * tokenmaxxing deployment.
 *
 *   bun apps/api/script/sandbox-server.ts [--port 8799]
 *
 * Used by the Windows service e2e (apps/cli/e2e/windows). Control routes:
 *   GET  /__sandbox/health
 *   POST /__sandbox/cli-token   { deviceId?, login? } -> { deviceId, login, token, userId }
 *   POST /__sandbox/revoke      { userId, revoked }   revokes or restores a user's CLI tokens
 *   GET  /__sandbox/usage?userId=   stored usage_days rows for one user
 *   GET  /__sandbox/requests    API request log (method, path, status, auth kind)
 */
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { applyMigrations } from "@tokenmaxxing/db/migrations";
import { Context, Effect, Layer, Scope } from "effect";
import * as FileSystem from "effect/FileSystem";
import { HttpEffect } from "effect/unstable/http";

import { generateCliToken, hashCliToken } from "../src/auth/crypto";
import { AppConfig } from "../src/config";
import { Drizzle } from "../src/database";
import { makeApiHttpEffect } from "../src/http/layer";
import { OAuthProviders } from "../src/oauth/registry";
import { ServicesLive } from "../src/services";
import { makeMemoryBucket } from "../src/testing/r2";
import { makeD1Database } from "../src/testing/sqlite-d1";
import * as seed from "../src/testing/seed";

interface RequestLogEntry {
  at: string;
  auth: "cli" | "bearer" | "none";
  method: string;
  path: string;
  status: number;
}

const port = Number(flag("port") ?? "8799");
const origin = `http://127.0.0.1:${port}`;

const sqlite = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
applyMigrations(sqlite);

const d1 = serializeD1(makeD1Database(sqlite));

const oauthDisabled = (id: "github" | "google") => ({
  authorizeUrl: () => `${origin}/__sandbox/oauth-disabled`,
  exchangeCode: () => Effect.die(`sandbox: ${id} OAuth is disabled`),
  fetchProfile: () => Effect.die(`sandbox: ${id} OAuth is disabled`),
  id,
});

const InfrastructureLive = Layer.mergeAll(
  Layer.succeed(AppConfig, {
    adminEmails: [],
    apiWorkerName: "tokenmaxxing-api-sandbox",
    corsOrigins: [origin],
    github: { clientId: "sandbox", clientSecret: "sandbox" },
    google: { clientId: "sandbox", clientSecret: "sandbox" },
    productName: "Tokenmaxxing",
  }),
  Drizzle.layer({ raw: Effect.succeed(d1) }),
  makeMemoryBucket().layer,
);

const scope = Effect.runSync(Scope.make());
// ServicesLive's real OAuth providers are swapped for disabled ones, so the
// sandbox never reaches GitHub or Google.
const services = await Effect.runPromise(
  Layer.buildWithScope(ServicesLive.pipe(Layer.provideMerge(InfrastructureLive)), scope).pipe(
    Effect.map((context) =>
      Context.add(context, OAuthProviders, {
        github: oauthDisabled("github"),
        google: oauthDisabled("google"),
      }),
    ),
  ),
);
const httpEffect = await Effect.runPromise(
  makeApiHttpEffect(Layer.succeedContext(services)).pipe(
    Effect.provide(FileSystem.layerNoop({})),
    Effect.provideService(Scope.Scope, scope),
  ),
);
const handleApi = HttpEffect.toWebHandler(httpEffect);

const requestLog: RequestLogEntry[] = [];

const server = Bun.serve({
  hostname: "127.0.0.1",
  idleTimeout: 120,
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/__sandbox/")) {
      return handleControl(request, url);
    }

    const response = await handleApi(request);
    const authorization = request.headers.get("authorization") ?? "";
    requestLog.push({
      at: new Date().toISOString(),
      auth: authorization.startsWith("Bearer tmx_") ? "cli" : authorization ? "bearer" : "none",
      method: request.method,
      path: url.pathname,
      status: response.status,
    });
    console.log(
      `${new Date().toISOString()} ${request.method} ${url.pathname} -> ${response.status}`,
    );
    return response;
  },
});

console.log(`tokenmaxxing API sandbox listening on http://127.0.0.1:${server.port}`);

async function handleControl(request: Request, url: URL): Promise<Response> {
  const body = (request.method === "POST" ? await request.json().catch(() => ({})) : {}) as Record<
    string,
    unknown
  >;

  switch (url.pathname) {
    case "/__sandbox/health":
      return Response.json({ ok: true, port: server.port });
    case "/__sandbox/cli-token":
      return Response.json(await mintCliToken(body));
    case "/__sandbox/revoke": {
      const userId = String(body.userId);
      sqlite
        .prepare("update cli_tokens set revoked_at = ? where user_id = ?")
        .run(body.revoked === true ? Date.now() : null, userId);
      return Response.json({ ok: true });
    }
    case "/__sandbox/usage":
      return Response.json({
        rows: sqlite
          .prepare(
            `select date, source, model, input_tokens as inputTokens, total_tokens as totalTokens
             from usage_days where user_id = ? order by date, source, model`,
          )
          .all(url.searchParams.get("userId")),
      });
    case "/__sandbox/requests":
      return Response.json({ requests: requestLog });
    default:
      return Response.json({ error: "unknown sandbox route" }, { status: 404 });
  }
}

async function mintCliToken(body: Record<string, unknown>) {
  const userId = randomUUID();
  const login = typeof body.login === "string" ? body.login : `e2e-${userId.slice(0, 8)}`;
  const deviceId = typeof body.deviceId === "string" ? body.deviceId : randomUUID();
  const now = Date.now();
  seed.seedUser(sqlite, { createdAt: now, id: userId, login, name: login });
  seed.seedAccount(sqlite, {
    email: `${login}@sandbox.test`,
    emailVerified: true,
    providerAccountId: `sandbox-${userId}`,
    userId,
  });
  seed.seedDevice(sqlite, { createdAt: now, id: deviceId, name: "sandbox", userId });

  const token = generateCliToken();
  sqlite
    .prepare(
      `insert into cli_tokens (id, token_hash, user_id, device_id, name, created_at, revoked_at)
       values (?, ?, ?, ?, 'sandbox', ?, null)`,
    )
    .run(randomUUID(), await Effect.runPromise(hashCliToken(token)), userId, deviceId, now);

  return { deviceId, login, token, userId };
}

/**
 * Real D1 runs a batch atomically; the sqlite shim awaits between a batch's
 * statements, so concurrent requests could interleave with its transaction.
 * Queue every D1 call behind the previous one.
 */
function serializeD1(inner: D1Database): D1Database {
  let tail: Promise<unknown> = Promise.resolve();
  const queued = <A>(run: () => Promise<A>): Promise<A> => {
    const next = tail.then(run, run);
    tail = next.catch(() => undefined);
    return next;
  };
  const unwrapped = new WeakMap<object, D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = {
      all: () => queued(() => statement.all()),
      bind: (...values: unknown[]) => wrap(statement.bind(...values)),
      first: (column?: string) => queued(() => statement.first(column as string)),
      raw: (options?: { columnNames?: boolean }) =>
        queued(() => statement.raw(options as { columnNames: true })),
      run: () => queued(() => statement.run()),
    } as unknown as D1PreparedStatement;
    unwrapped.set(wrapped, statement);
    return wrapped;
  };

  return {
    batch: (statements: D1PreparedStatement[]) =>
      queued(() =>
        inner.batch(statements.map((statement) => unwrapped.get(statement) ?? statement)),
      ),
    exec: (query: string) => queued(() => inner.exec(query)),
    prepare: (query: string) => wrap(inner.prepare(query)),
  } as unknown as D1Database;
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

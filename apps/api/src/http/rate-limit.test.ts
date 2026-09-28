import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { CliLoginService } from "../clilogin/service";
import { RATE_LIMIT_RULES } from "../ratelimit/service";
import { makeTestApp, type TestApp } from "../testing/http";
import { type FakeRateLimiter, makeFakeRateLimiter } from "../testing/rate-limiter";

/**
 * The per-IP caps on the unauthenticated CLI login endpoints, through the
 * real router: the limit runs before the service (and so before D1), keys
 * on cf-connecting-ip only, and answers 429 in the shared error envelope
 * with a Retry-After header.
 */

const START_BODY = {
  deviceArch: "arm64",
  deviceId: "7d0f3a52-5f0a-4f39-9d7c-3b8f1c2a9e11",
  deviceName: "fixture-host",
  devicePlatform: "darwin",
  deviceVersion: "0.0.0-fixture",
  flow: "device_code",
};

const POLL_BODY = { deviceCode: "device-code-secret" };

const START_LIMIT = RATE_LIMIT_RULES.cliLoginStart.limit;
const POLL_LIMIT = RATE_LIMIT_RULES.cliLoginPoll.limit;

let app: TestApp;
let limiter: FakeRateLimiter;
let cliLogin: {
  poll: ReturnType<typeof vi.fn<CliLoginService["Service"]["poll"]>>;
  start: ReturnType<typeof vi.fn<CliLoginService["Service"]["start"]>>;
};

beforeEach(async () => {
  limiter = makeFakeRateLimiter();
  cliLogin = {
    poll: vi.fn<CliLoginService["Service"]["poll"]>(() => Effect.succeed({ status: "pending" })),
    start: vi.fn<CliLoginService["Service"]["start"]>(() =>
      Effect.succeed({
        code: "ABCD-1234",
        deviceCode: "device-code-secret",
        expiresAt: "2026-09-27T12:10:00.000Z",
        intervalSeconds: 2,
        userCode: "ABCD-1234",
        verificationUri: "https://tokenmaxxing.sh/login/cli?code=ABCD-1234",
      }),
    ),
  };
  app = await makeTestApp({ cliLogin, rateLimiter: limiter.service });
});

afterEach(() => app.close());

function post(
  path: "/cli/login/poll" | "/cli/login/start",
  headers: Record<string, string>,
  body: unknown = path === "/cli/login/start" ? START_BODY : POLL_BODY,
) {
  return app.fetch(
    new Request(`https://api.tokenmaxxing.sh${path}`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", host: "api.tokenmaxxing.sh", ...headers },
      method: "POST",
    }),
  );
}

async function repeat(times: number, send: () => Promise<Response>) {
  const statuses: number[] = [];
  for (let index = 0; index < times; index += 1) {
    statuses.push((await send()).status);
  }
  return statuses;
}

async function expectTooManyRequests(response: Response) {
  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toBe("60");
  expect(response.headers.get("x-request-id")).not.toBeNull();
  expect(await response.json()).toEqual({
    _tag: "TooManyRequests",
    message: expect.stringMatching(/; try again in 60 seconds\.$/),
    retryAfterSeconds: 60,
  });
}

describe("POST /cli/login/start", () => {
  const ip = { "cf-connecting-ip": "203.0.113.9" };

  it("serves requests under the cap", async () => {
    expect(await repeat(START_LIMIT, () => post("/cli/login/start", ip))).toEqual(
      Array(START_LIMIT).fill(200),
    );
    expect(cliLogin.start).toHaveBeenCalledTimes(START_LIMIT);
  });

  it("answers 429 with Retry-After over the cap, without calling the service", async () => {
    await repeat(START_LIMIT, () => post("/cli/login/start", ip));

    await expectTooManyRequests(await post("/cli/login/start", ip));
    await expectTooManyRequests(await post("/cli/login/start", ip));
    expect(cliLogin.start).toHaveBeenCalledTimes(START_LIMIT);
  });

  it("counts each client IP separately", async () => {
    await repeat(START_LIMIT + 1, () => post("/cli/login/start", ip));

    const other = await post("/cli/login/start", { "cf-connecting-ip": "198.51.100.7" });

    expect(other.status).toBe(200);
  });

  it("counts a whole IPv6 /64 as one client", async () => {
    await repeat(START_LIMIT, () =>
      post("/cli/login/start", { "cf-connecting-ip": "2001:db8:0:1::1" }),
    );

    await expectTooManyRequests(
      await post("/cli/login/start", { "cf-connecting-ip": "2001:db8:0:1:ffff::2" }),
    );
    expect((await post("/cli/login/start", { "cf-connecting-ip": "2001:db8:0:2::1" })).status).toBe(
      200,
    );
  });

  it("never trusts client-supplied forwarding headers", async () => {
    let forwarded = 0;
    const statuses = await repeat(START_LIMIT + 1, () =>
      post("/cli/login/start", {
        ...ip,
        "x-forwarded-for": `198.51.100.${(forwarded += 1)}`,
        "x-real-ip": `198.51.100.${forwarded}`,
      }),
    );

    expect(statuses.at(-1)).toBe(429);
    expect(new Set(limiter.calls.map(({ key }) => key))).toEqual(new Set(["203.0.113.9"]));
  });

  it("does not limit requests that did not come through Cloudflare", async () => {
    // Local dev, the sandbox and tests send no cf-connecting-ip.
    const statuses = await repeat(START_LIMIT * 3, () =>
      post("/cli/login/start", { "x-forwarded-for": "203.0.113.9" }),
    );

    expect(statuses).toEqual(Array(START_LIMIT * 3).fill(200));
    expect(limiter.calls).toEqual([]);
  });

  it("keeps the Retry-After header when the body arrives without a Content-Length", async () => {
    await repeat(START_LIMIT, () => post("/cli/login/start", ip));

    const body = new TextEncoder().encode(JSON.stringify(START_BODY));
    const chunked = await app.fetch(
      new Request("https://api.tokenmaxxing.sh/cli/login/start", {
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(body);
            controller.close();
          },
        }),
        // Node requires half-duplex for a streamed request body.
        duplex: "half",
        headers: { "content-type": "application/json", ...ip },
        method: "POST",
      } as RequestInit),
    );

    await expectTooManyRequests(chunked);
  });

  it("still rejects undeclared properties and oversized bodies first-class", async () => {
    const undeclared = await post("/cli/login/start", ip, { ...START_BODY, extra: true });
    expect(undeclared.status).toBe(400);
    expect(await undeclared.json()).toMatchObject({ _tag: "BadRequest" });

    // The body cap answers before the handler, so it costs no limiter call.
    const calls = limiter.calls.length;
    const oversized = await post("/cli/login/start", ip, {
      ...START_BODY,
      padding: "x".repeat(64 * 1024),
    });
    expect(oversized.status).toBe(413);
    expect(limiter.calls.length).toBe(calls);
    expect(cliLogin.start).not.toHaveBeenCalled();
  });
});

describe("POST /cli/login/poll", () => {
  const ip = { "cf-connecting-ip": "203.0.113.9" };

  it("lets a normal login poll through and stops a flood before the service", async () => {
    expect(await repeat(POLL_LIMIT, () => post("/cli/login/poll", ip))).toEqual(
      Array(POLL_LIMIT).fill(200),
    );

    const flood = await repeat(20, () => post("/cli/login/poll", ip));

    expect(flood).toEqual(Array(20).fill(429));
    expect(cliLogin.poll).toHaveBeenCalledTimes(POLL_LIMIT);
    await expectTooManyRequests(await post("/cli/login/poll", ip));
  });

  it("counts polls separately from starts", async () => {
    await repeat(START_LIMIT + 1, () => post("/cli/login/start", ip));

    expect((await post("/cli/login/poll", ip)).status).toBe(200);
  });
});

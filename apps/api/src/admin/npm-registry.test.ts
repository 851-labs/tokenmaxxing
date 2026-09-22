import { Duration, Effect } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { describe, expect, it } from "vite-plus/test";

import {
  latestReleaseFromRegistryBody,
  makeNpmRegistry,
  noLatestCliRelease,
  type NpmRegistryShape,
} from "./npm-registry";
import { latestRelease } from "./test-fixtures";

describe("latestReleaseFromRegistryBody", () => {
  it("reads the latest dist tag and release timestamp from npm package metadata", () => {
    expect(
      latestReleaseFromRegistryBody({
        "dist-tags": {
          alpha: "0.5.5-alpha.1",
          beta: "0.5.5-beta.1",
          latest: "0.5.4",
          rc: "0.5.5-rc.1",
        },
        time: { "0.5.4": "2026-06-19T19:00:00.000Z" },
      }),
    ).toEqual({
      ...latestRelease,
      versions: {
        ...latestRelease.versions,
        beta: "0.5.5-beta.1",
        rc: "0.5.5-rc.1",
      },
    });
  });

  it("ignores empty or non-string tags and falls back to the top-level version", () => {
    expect(
      latestReleaseFromRegistryBody({
        "dist-tags": { alpha: "" },
        time: { "0.5.4": "2026-06-19T19:00:00.000Z", unpublished: { time: "x" } },
        version: "0.5.4",
      }),
    ).toEqual({
      publishedAt: "2026-06-19T19:00:00.000Z",
      version: "0.5.4",
      versions: { alpha: null, beta: null, latest: "0.5.4", rc: null },
    });
    expect(latestReleaseFromRegistryBody({ "dist-tags": { latest: 7 } })).toEqual(
      noLatestCliRelease(),
    );
    expect(latestReleaseFromRegistryBody(null)).toEqual(noLatestCliRelease());
  });
});

const registryBody = {
  "dist-tags": { latest: "0.5.4" },
  time: { "0.5.4": "2026-06-19T19:00:00.000Z" },
};

function makeRegistry(
  respond: (signal: AbortSignal) => Response | "hang",
  options: { timeout?: Duration.Input } = {},
): { calls: () => number; registry: NpmRegistryShape } {
  let calls = 0;
  const http = HttpClient.make((request, _url, signal) => {
    calls += 1;
    const response = respond(signal);
    return response === "hang"
      ? Effect.never
      : Effect.succeed(HttpClientResponse.fromWeb(request, response));
  });
  const registry = Effect.runSync(
    makeNpmRegistry(options).pipe(Effect.provideService(HttpClient.HttpClient, http)),
  );

  return { calls: () => calls, registry };
}

describe("NpmRegistry.latestCliRelease", () => {
  it("caches a successful lookup", async () => {
    const { calls, registry } = makeRegistry(() => Response.json(registryBody));

    const first = await Effect.runPromise(registry.latestCliRelease);
    const second = await Effect.runPromise(registry.latestCliRelease);

    expect(first.version).toBe("0.5.4");
    expect(second).toEqual(first);
    expect(calls()).toBe(1);
  });

  it("degrades failures to no release and retries on the next lookup", async () => {
    let status = 503;
    const { calls, registry } = makeRegistry(() =>
      status === 200 ? Response.json(registryBody) : new Response("down", { status }),
    );

    await expect(Effect.runPromise(registry.latestCliRelease)).resolves.toEqual(
      noLatestCliRelease(),
    );
    status = 200;
    await expect(Effect.runPromise(registry.latestCliRelease)).resolves.toMatchObject({
      version: "0.5.4",
    });
    expect(calls()).toBe(2);
  });

  it("aborts a registry request that exceeds the timeout", async () => {
    let signal: AbortSignal | undefined;
    const { registry } = makeRegistry(
      (requestSignal) => {
        signal = requestSignal;
        return "hang";
      },
      { timeout: "10 millis" },
    );

    await expect(Effect.runPromise(registry.latestCliRelease)).resolves.toEqual(
      noLatestCliRelease(),
    );
    expect(signal?.aborted).toBe(true);
  });
});

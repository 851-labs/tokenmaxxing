import * as OpenApi from "effect/unstable/httpapi/OpenApi";
import { describe, expect, it } from "vite-plus/test";

import { TokenmaxxingApi } from "./api";

/**
 * Published CLIs bundle a frozen copy of this contract, so the endpoints they
 * call must never change incompatibly: no renamed paths or methods, no newly
 * required or removed request fields, no narrowed response fields. This
 * snapshot pins the OpenAPI slice for those endpoints (plus the legacy
 * `/usage/sync` old CLIs still call). When it changes, check the diff for
 * breakage before updating it, and add a fixture under
 * fixtures/cli-requests/legacy for any shape a released CLI still sends.
 */

const CLI_OPERATIONS = [
  "cliLogin.poll",
  "cliLogin.start",
  "me.me",
  "usage.checkIn",
  "usage.ingest",
  "usage.logout",
  "usage.sync",
];

function collectRefs(value: unknown, refs: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectRefs(item, refs);
    }
  } else if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (key === "$ref" && typeof entry === "string") {
        refs.add(entry.replace("#/components/schemas/", ""));
      } else {
        collectRefs(entry, refs);
      }
    }
  }
}

function cliEndpointSpec() {
  const spec = OpenApi.fromApi(TokenmaxxingApi);
  const paths: Record<string, Record<string, unknown>> = {};
  const operationIds: string[] = [];

  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(item as Record<string, unknown>)) {
      const operationId = (operation as { operationId?: string } | undefined)?.operationId;
      if (operationId !== undefined && CLI_OPERATIONS.includes(operationId)) {
        paths[path] = { ...paths[path], [method]: operation };
        operationIds.push(operationId);
      }
    }
  }

  const schemas = spec.components?.schemas ?? {};
  const refs = new Set<string>();
  collectRefs(paths, refs);
  // Set iteration also visits refs added mid-loop, closing over nested refs.
  for (const ref of refs) {
    collectRefs(schemas[ref], refs);
  }

  return {
    components: Object.fromEntries([...refs].sort().map((ref) => [ref, schemas[ref]])),
    operationIds: operationIds.sort(),
    paths,
  };
}

describe("CLI endpoint contract", () => {
  it("exposes every endpoint the CLI calls", () => {
    expect(cliEndpointSpec().operationIds).toEqual(CLI_OPERATIONS);
  });

  it("matches the pinned OpenAPI slice", async () => {
    await expect(`${JSON.stringify(cliEndpointSpec(), null, 2)}\n`).toMatchFileSnapshot(
      "../fixtures/cli-endpoints.openapi.json",
    );
  });
});

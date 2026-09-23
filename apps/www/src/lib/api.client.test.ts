// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { fetchViewer } from "./api";

/** Browser-side API calls: what actually goes over the wire. */

const requests: Request[] = [];
let respond: () => Response = () => new Response(null, { status: 500 });

// Installed before the first call: the HTTP client keeps the fetch it first sees.
vi.stubGlobal(
  "fetch",
  vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input, init));
    return respond();
  }),
);

beforeEach(() => {
  requests.length = 0;
});

describe("fetchViewer in the browser", () => {
  it("reads a 401 as signed out, not an error", async () => {
    respond = () =>
      Response.json({ _tag: "Unauthorized", message: "Not signed in." }, { status: 401 });

    await expect(fetchViewer()).resolves.toBeNull();
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual(["/me"]);
  });

  it("sends no trace headers, so a GET needs no CORS preflight", async () => {
    const user = { avatarUrl: null, id: "user_1", login: "alice", name: null };
    respond = () => Response.json({ user });

    await expect(fetchViewer()).resolves.toEqual({ user });
    const [request] = requests;
    expect(request?.credentials).toBe("include");
    expect(request?.headers.has("traceparent")).toBe(false);
    expect(request?.headers.has("b3")).toBe(false);
  });
});

import { describe, expect, it } from "vite-plus/test";

import { trailingSlashRedirect } from "./trailing-slash";

function redirectOf(url: string, method = "GET") {
  const response = trailingSlashRedirect(new Request(url, { method }));

  return response === null
    ? null
    : { location: response.headers.get("location"), status: response.status };
}

describe("trailingSlashRedirect", () => {
  it("permanently redirects a trailing-slash URL to the one without", () => {
    expect(redirectOf("https://tokenmaxxing.sh/stats/")).toEqual({
      location: "https://tokenmaxxing.sh/stats",
      status: 301,
    });
    expect(redirectOf("https://tokenmaxxing.sh/pondorasti/", "HEAD")).toEqual({
      location: "https://tokenmaxxing.sh/pondorasti",
      status: 301,
    });
    expect(redirectOf("https://tokenmaxxing.sh/sitemap.xml/")?.location).toBe(
      "https://tokenmaxxing.sh/sitemap.xml",
    );
  });

  it("keeps the query string", () => {
    expect(redirectOf("https://tokenmaxxing.sh/pondorasti/?agent=claude&range=1m")?.location).toBe(
      "https://tokenmaxxing.sh/pondorasti?agent=claude&range=1m",
    );
  });

  it("leaves the home page and slash-less URLs to the router", () => {
    expect(redirectOf("https://tokenmaxxing.sh/")).toBeNull();
    expect(redirectOf("https://tokenmaxxing.sh/?window=7d")).toBeNull();
    expect(redirectOf("https://tokenmaxxing.sh/stats")).toBeNull();
    expect(redirectOf("https://tokenmaxxing.sh/og/pondorasti.png?v=1")).toBeNull();
  });

  it("collapses repeated slashes in one hop", () => {
    expect(redirectOf("https://tokenmaxxing.sh/stats///")?.location).toBe(
      "https://tokenmaxxing.sh/stats",
    );
  });

  it("never redirects off the site", () => {
    for (const path of ["//evil.example/", "/%2F%2Fevil.example/", "/\\\\evil.example/"]) {
      const location = redirectOf(`https://tokenmaxxing.sh${path}`)?.location;

      expect({ origin: new URL(location ?? "").origin, path }).toEqual({
        origin: "https://tokenmaxxing.sh",
        path,
      });
    }
  });

  it("only answers reads", () => {
    expect(redirectOf("https://tokenmaxxing.sh/stats/", "POST")).toBeNull();
  });
});

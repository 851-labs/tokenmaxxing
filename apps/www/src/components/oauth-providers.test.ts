import { describe, expect, it } from "vite-plus/test";

import { LOGIN_OAUTH_PROVIDERS, oauthProviderLinks } from "./oauth-providers";

describe("oauthProviderLinks", () => {
  it("builds provider links without a redirect", () => {
    const [github, google] = oauthProviderLinks();
    if (github === undefined) {
      throw new Error("expected GitHub provider");
    }
    if (google === undefined) {
      throw new Error("expected Google provider");
    }

    expect(github.id).toBe("github");
    expect(github.label).toBe("Continue with GitHub");
    expect(google.id).toBe("google");
    expect(google.label).toBe("Continue with Google");

    const githubUrl = new URL(github.href);
    expect(githubUrl.pathname).toBe("/auth/github/start");
    expect(githubUrl.searchParams.get("redirect")).toBeNull();

    const googleUrl = new URL(google.href);
    expect(googleUrl.pathname).toBe("/auth/google/start");
    expect(googleUrl.searchParams.get("redirect")).toBeNull();
  });

  it("builds GitHub-only login links", () => {
    const links = oauthProviderLinks({ providers: LOGIN_OAUTH_PROVIDERS });
    const [github] = links;

    expect(links).toHaveLength(1);
    expect(github?.id).toBe("github");
    expect(github?.label).toBe("Continue with GitHub");
  });

  it("keeps the CLI login redirect on GitHub-only login links", () => {
    const links = oauthProviderLinks({
      providers: LOGIN_OAUTH_PROVIDERS,
      redirect: "/login/cli?code=ABCD-1234",
    });
    const [github] = links;
    if (github === undefined) {
      throw new Error("expected GitHub provider");
    }

    const githubUrl = new URL(github.href);

    expect(links).toHaveLength(1);
    expect(githubUrl.pathname).toBe("/auth/github/start");
    expect(githubUrl.searchParams.get("redirect")).toBe("/login/cli?code=ABCD-1234");
  });
});

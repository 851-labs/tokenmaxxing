import { createFileRoute, notFound, redirect } from "@tanstack/react-router";

import { ProfileOgCard } from "./-components/og-cards";
import { isOldLogin, LOGIN_REDIRECT_HEADERS } from "../../lib/login-redirect";
import { loadProfileOgData } from "../../lib/og-data";

const Route = createFileRoute("/og-card/$login")({
  loader: async ({ params }) => {
    const data = await loadProfileOgData(params.login);
    if (data === null) {
      throw notFound();
    }
    const login = data.profile.user.login;
    if (isOldLogin(params.login, login)) {
      throw redirect({
        headers: LOGIN_REDIRECT_HEADERS,
        params: { login },
        statusCode: 301,
        to: "/og-card/$login",
      });
    }

    return {
      data,
    };
  },
  head: () => ({
    meta: [{ content: "noindex", name: "robots" }],
  }),
  component: OgCardPage,
});

function OgCardPage() {
  const { data } = Route.useLoaderData();

  return <ProfileOgCard data={data} />;
}

export { ProfileOgCard, Route };

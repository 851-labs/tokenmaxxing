import { Context, Effect, Layer } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import type { OAuthProviderId } from "@tokenmaxxing/api-contract";

import { makeGitHubProvider } from "./github";
import { makeGoogleProvider } from "./google";
import type { OAuthProvider } from "./provider";

/** Every supported provider, keyed by id — adding an id to OAuthProviderId
 * fails to typecheck until its provider is registered here. */
class OAuthProviders extends Context.Service<
  OAuthProviders,
  Readonly<Record<OAuthProviderId, OAuthProvider>>
>()("@tokenmaxxing/api/OAuthProviders") {}

const OAuthProvidersLive = Layer.effect(
  OAuthProviders,
  Effect.all({ github: makeGitHubProvider(), google: makeGoogleProvider() }),
).pipe(Layer.provide(FetchHttpClient.layer));

export { OAuthProviders, OAuthProvidersLive };

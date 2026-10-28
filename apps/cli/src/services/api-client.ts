import { Context, Effect, Layer } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import { TokenmaxxingApi } from "@tokenmaxxing/api-contract";

/**
 * The typed client derived from the shared contract — every call the CLI
 * makes goes through here, authenticated by the `tmx_` bearer when one is
 * configured.
 */

type TokenmaxxingApiClient = HttpApiClient.ForApi<typeof TokenmaxxingApi>;

interface ApiClientOptions {
  baseUrl: string;
  token?: string | undefined;
}

class ApiClientService extends Context.Service<
  ApiClientService,
  {
    readonly make: (options: ApiClientOptions) => Effect.Effect<TokenmaxxingApiClient>;
  }
>()("ApiClientService") {}

const ApiClientLive = Layer.succeed(ApiClientService)({
  make: (options) =>
    HttpApiClient.make(TokenmaxxingApi, {
      baseUrl: options.baseUrl.replace(/\/$/, ""),
      ...(options.token === undefined
        ? {}
        : {
            transformClient: (client: HttpClient.HttpClient) =>
              client.pipe(
                HttpClient.mapRequest(
                  HttpClientRequest.setHeader("authorization", `Bearer ${options.token}`),
                ),
              ),
          }),
    }).pipe(Effect.provide(FetchHttpClient.layer)),
});

export { ApiClientLive, ApiClientService };

export type { TokenmaxxingApiClient };

declare module "cloudflare:workers" {
  export const env: unknown;
  /** Extends the current request's lifetime until the promise settles. */
  export function waitUntil(promise: Promise<unknown>): void;
}

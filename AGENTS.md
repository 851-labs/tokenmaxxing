# Repository Instructions

## Effect Error Style

- Prefer native Effect errors over plain JavaScript `Error` subclasses in Effect code.
- Use `Data.TaggedError` for internal typed errors that stay inside the Effect error channel.
- Use `Schema.TaggedError` when an error is part of a public schema or wire contract.
- Avoid `throw` for expected domain failures; return `Effect.fail(...)` with a typed error instead.

## Export Style

- Prefer local declarations first and grouped exports at the end of each authored source file.
- Use `export { ... }` for runtime values and `export type { ... }` for type-only exports.
- Put default exports at the end too, using a named local value before `export default name;`.
- Do not hand-edit generated files just to satisfy this style rule.

## Conventions

- Daily usage rows are keyed `(deviceId, date, source, model)` and upserted; sync must stay idempotent.
- Cost is frozen at first upload unless the usage (token counts) changes: the `usage_days` upsert keeps the stored `cost_usd` when all token columns match (ccusage re-prices unmarked Codex history with the device's current speed tier), takes the incoming cost when any token count differs, and prices a row stored at 0. Fixing already-stored cost means editing D1 directly; re-ingesting payloads with the same tokens is a no-op for cost.
- `date` columns are opaque `YYYY-MM-DD` strings (ccusage local-time buckets); never parse them into Date objects for bucketing. Do day arithmetic with `shiftDayKey`/`utcDayKey` from `@tokenmaxxing/api-contract` (API windows live in `apps/api/src/date-keys.ts`).
- Published CLIs bundle a frozen contract. `packages/api-contract/fixtures/` (recorded CLI requests + the CLI endpoint OpenAPI slice) is a compatibility contract: review diffs there as breaking-change reviews, and add a `legacy/` fixture before changing a shape a released CLI sends. Responses go the other way: `apps/api/src/http/cli-compat.test.ts` decodes every replayed response and typed CLI error with frozen copies of the released CLI decoders, so fields may be added but never dropped, renamed or retyped, and error `_tag`s never change. `fixtures/full-api.openapi.json` snapshots the whole API as a review aid; only the CLI slice is frozen.
- CLI tokens (`tmx_` prefix) never expire; revocation (`revokedAt`) is the only kill switch.
- D1 caps a statement at 100 bound parameters, and the sqlite test harness (`apps/api/src/testing/sqlite-d1.ts`) enforces it. Never bind an unbounded list: chunk it, or pass it as one JSON parameter through `json_each`.
- Keep `bun run test` output clean. A test that exercises a logging path captures and asserts the log (`makeTestLogger` in `apps/api/src/testing/logger.ts`; `vi.spyOn(console, ...)` outside Effect) instead of letting it print. `makeTestApp` already captures into `app.logs`. Captured Effect logs are replayed when a test fails.

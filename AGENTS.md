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
- `date` columns are opaque `YYYY-MM-DD` strings (ccusage local-time buckets); never parse them into Date objects for bucketing.
- CLI tokens (`tmx_` prefix) never expire; revocation (`revokedAt`) is the only kill switch.

## CLI Output Style

- Foreground human CLI commands should wrap async work in `humanSpinner` inside `humanFrame`.
  This includes network calls, filesystem writes, subprocesses, scheduler changes, package-manager
  updates, browser opens, and other operations that can visibly pause.
- Keep machine output clean: `--json`, `silent`, and scheduled/background service paths must not emit
  spinners or decorative human logs.
- Prefer shared output helpers (`humanFrame`, `humanSpinner`, `humanLog`, `formatUrl`,
  `formatHighlight`, `writeJson`) over raw `console` output in foreground commands.
- Spinner rows should resolve into the final success or error row for that operation instead of adding
  a separate duplicate row.
- Do not use indefinite spinners while waiting for external user action; show the actionable
  URL/code/instruction and then wait quietly.

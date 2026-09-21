# CLI Instructions

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

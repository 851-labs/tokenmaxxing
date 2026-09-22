import { Flag } from "effect/unstable/cli";

/**
 * A presence flag: `--name` is true, omitting it is false. Since effect
 * 4.0.0-rc.117 a bare `Flag.Boolean` is a *required* flag, so every boolean
 * flag must be built here — src/argv.test.ts runs each command with its
 * flags omitted to keep it that way.
 */
function booleanFlag(name: string) {
  return Flag.Boolean(name).pipe(Flag.withDefault(false));
}

export { booleanFlag };

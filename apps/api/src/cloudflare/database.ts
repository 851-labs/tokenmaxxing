import { RemovalPolicy } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Stack } from "alchemy/Stack";

import { stageNameForResource } from "./stage";

function databaseNameForStage(stage: string): string {
  return `tokenmaxxing-${stageNameForResource(stage)}`;
}

/**
 * drizzle-kit v1 migration folders, applied on every deploy. Bookkeeping
 * stays in `d1_migrations`, where earlier deploys recorded history; alchemy
 * converts that table in place and matches its rows to folders by name.
 */
const migrations = {
  dir: "./packages/db/migrations",
  table: "d1_migrations",
} satisfies Cloudflare.D1.DatabaseProps["migrations"];

const Database = Cloudflare.D1.Database(
  "DB",
  // Annotated so a misspelled prop fails to compile: an inferred object
  // silently dropped the old `migrationsDir`, and deploys skipped migrations.
  Stack.useSync(({ stage }): Cloudflare.D1.DatabaseProps => ({
    name: databaseNameForStage(stage),
    migrations,
  })),
).pipe(RemovalPolicy.retain());

export { Database, migrations };

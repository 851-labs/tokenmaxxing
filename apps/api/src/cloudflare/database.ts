import { RemovalPolicy } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Stack } from "alchemy/Stack";

import { stageNameForResource } from "./stage";

function databaseNameForStage(stage: string): string {
  return `tokenmaxxing-${stageNameForResource(stage)}`;
}

const Database = Cloudflare.D1.Database(
  "DB",
  Stack.useSync(({ stage }) => ({
    name: databaseNameForStage(stage),
    migrationsDir: "./packages/db/migrations",
  })),
).pipe(RemovalPolicy.retain());

export { Database };

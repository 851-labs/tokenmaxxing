import { RemovalPolicy } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Stack } from "alchemy/Stack";

import { stageNameForResource } from "./stage";

function bucketNameForStage(stage: string): string {
  return `tokenmaxxing-${stageNameForResource(stage)}`;
}

const Bucket = Cloudflare.R2.Bucket(
  "BUCKET",
  Stack.useSync(({ stage }) => ({
    name: bucketNameForStage(stage),
  })),
).pipe(RemovalPolicy.retain());

export { Bucket };

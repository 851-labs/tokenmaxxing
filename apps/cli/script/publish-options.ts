interface PublishCliOptions {
  dryRun?: boolean | undefined;
  outDir?: string | undefined;
  provenance?: boolean | undefined;
  tag?: string | undefined;
}

function parsePublishCliArgs(argv: readonly string[]): PublishCliOptions {
  const options: PublishCliOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--no-provenance") {
      options.provenance = false;
      continue;
    }
    if (arg === "--out-dir") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--out-dir requires a value");
      }
      options.outDir = value;
      index += 1;
      continue;
    }
    if (arg === "--tag") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--tag requires a value");
      }
      options.tag = value;
      index += 1;
      continue;
    }

    throw new Error(`unknown argument ${arg}`);
  }

  return options;
}

function npmDistTagForVersion(version: string): string {
  const prerelease = /-(?<tag>[0-9A-Za-z]+)(?:[.-]|$)/.exec(version)?.groups?.tag;
  return prerelease === undefined ? "latest" : prerelease;
}

export { npmDistTagForVersion, parsePublishCliArgs };
export type { PublishCliOptions };

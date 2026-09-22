import { defineConfig } from "vite-plus";

// The D1 test harness runs on node:sqlite, which Node 22 flags with an
// ExperimentalWarning per worker (Node 24, used in CI, does not). Silence only
// that warning class, only in the projects that open node:sqlite.
const nodeSqliteExecArgv = ["--disable-warning=ExperimentalWarning"];

const config = defineConfig({
  fmt: {
    ignorePatterns: [
      "**/routeTree.gen.ts",
      "packages/db/migrations/**",
      "**/.repos/**",
      // Written by toMatchFileSnapshot; formatting would break the match.
      "packages/api-contract/fixtures/**",
    ],
  },
  lint: {
    ignorePatterns: ["**/routeTree.gen.ts", "packages/db/migrations/**", "**/.repos/**"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  test: {
    projects: [
      { root: "./apps/api", test: { execArgv: nodeSqliteExecArgv, name: "api" } },
      { root: "./apps/cli", test: { name: "cli" } },
      {
        extends: "./apps/www/vite.config.ts",
        root: "./apps/www",
        test: { name: "www" },
      },
      { root: "./packages/api-contract", test: { name: "api-contract" } },
      { root: "./packages/db", test: { execArgv: nodeSqliteExecArgv, name: "db" } },
    ],
  },
});

export default config;

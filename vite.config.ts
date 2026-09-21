import { defineConfig } from "vite-plus";

const config = defineConfig({
  fmt: {
    ignorePatterns: ["**/routeTree.gen.ts", "packages/db/migrations/**", "**/.repos/**"],
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
      { root: "./apps/api", test: { name: "api" } },
      { root: "./apps/cli", test: { name: "cli" } },
      {
        extends: "./apps/www/vite.config.ts",
        root: "./apps/www",
        test: { name: "www" },
      },
      { root: "./packages/api-contract", test: { name: "api-contract" } },
      { root: "./packages/db", test: { name: "db" } },
    ],
  },
  run: {
    tasks: {
      "test:all": {
        command: "vp test run",
        output: [],
      },
    },
  },
});

export default config;

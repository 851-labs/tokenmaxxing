import { defineConfig } from "drizzle-kit";

const config = defineConfig({
  dialect: "sqlite",
  out: "./migrations",
  schema: "./src/schema/index.ts",
  verbose: true,
});

export default config;

import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

const config = defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  // Base UI ships ESM that imports React; let Vite bundle it through the app's
  // React instance for SSR instead of pre-bundling it (which resolves React to
  // null and forces a client-render fallback).
  ssr: {
    noExternal: ["@base-ui/react"],
  },
  plugins: [tanstackStart(), react(), tailwindcss()],
});

export default config;

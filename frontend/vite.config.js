import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `vite build --mode fixture` swaps the placeholder deployment for a dummy one, so the bundle keeps App's
// render paths and scripts/check-bundle.mjs can check them (issue #48). Other modes are unchanged.
const fixtureDeployment = fileURLToPath(new URL("./fixtures/deployment.json", import.meta.url));

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  resolve: {
    alias: mode === "fixture" ? [{ find: /^\.\/deployment\.json$/, replacement: fixtureDeployment }] : [],
  },
  test: {
    environment: "jsdom",
  },
}));

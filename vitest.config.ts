import { fileURLToPath, URL } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    // Offline script checks use node:test and are run separately from Vitest.
    exclude: [
      ...configDefaults.exclude,
      "scripts/package/mygo-release*.test.mjs",
      "scripts/diagnostics/*.test.mjs",
    ],
  },
});

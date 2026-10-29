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
    // These offline release checks use node:test and run through test:desktop:release.
    exclude: [...configDefaults.exclude, "scripts/package/mygo-release*.test.mjs"],
  },
});

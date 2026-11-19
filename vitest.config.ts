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
    server: {
      // 该包的 ESM 内部导入省略了扩展名，交给 Vite 解析。
      deps: { inline: ["@material/material-color-utilities"] },
    },
    // Offline script checks use node:test and are run separately from Vitest.
    exclude: [
      ...configDefaults.exclude,
      "scripts/package/mygo-release*.test.mjs",
      "scripts/diagnostics/*.test.mjs",
      "scripts/mygo.test.mjs",
      "scripts/mpv/*.test.mjs",
    ],
  },
});

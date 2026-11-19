import { resolve } from "node:path";
import { defineConfig, loadEnv, type UserConfig } from "vite";
import { NaiveUiResolver } from "unplugin-vue-components/resolvers";
import vue from "@vitejs/plugin-vue";
import AutoImport from "unplugin-auto-import/vite";
import Components from "unplugin-vue-components/vite";
import viteCompression from "vite-plugin-compression";
import wasm from "vite-plugin-wasm";

const vendorChunks = {
  "vue-vendor": ["vue", "vue-router", "pinia", "pinia-plugin-persistedstate", "vue-i18n"],
  "naive-ui": ["naive-ui"],
  "vendor-utils": ["lodash-es", "@vueuse/core", "axios", "dayjs", "js-cookie", "md5"],
  "color-theme": ["@material/material-color-utilities", "jss", "jss-preset-default"],
  "media-player": ["hls.js", "plyr"],
  markdown: ["marked", "github-markdown-css"],
  pixi: ["pixi.js"],
};

// Web 与 mygo 共用渲染配置。
export function createFrontendConfig(mode: string, desktop = false): UserConfig {
  const env = loadEnv(mode, process.cwd());
  const port = desktop ? 14667 : Number(env.VITE_WEB_PORT || 14666);
  return {
    root: ".",
    publicDir: resolve(import.meta.dirname, "public"),
    plugins: [
      vue(),
      AutoImport({
        imports: [
          "vue",
          "vue-router",
          "@vueuse/core",
          { "naive-ui": ["useDialog", "useMessage", "useNotification", "useLoadingBar"] },
        ],
        dts: false,
        eslintrc: {
          // 显式桌面探针不回写生成配置，避免污染运行期冻结的源码。
          enabled: !desktop || process.env.HE_MUSIC_NATIVE_PROBE !== "1",
          filepath: "./auto-eslint.mjs",
        },
      }),
      Components({ resolvers: [NaiveUiResolver()], dts: false }),
      viteCompression(),
      wasm(),
    ],
    resolve: { alias: { "@": resolve(import.meta.dirname, "src/") } },
    css: {
      preprocessorOptions: { scss: { silenceDeprecations: ["legacy-js-api"] } },
    },
    server: {
      port,
      host: "127.0.0.1",
      strictPort: true,
      // Web 与桌面共用项目根目录，各自构建时都不应触发开发页重载。
      watch: { ignored: ["**/dist/**"] },
    },
    preview: { port, host: "127.0.0.1", strictPort: true },
    build: {
      outDir: desktop ? "dist/desktop" : "dist/web",
      emptyOutDir: true,
      // 沿用 Vite 7 的浏览器目标，覆盖现有桌面 WebView。
      target: ["chrome107", "edge107", "firefox104", "safari16"],
      minify: "terser",
      rolldownOptions: {
        input: resolve(import.meta.dirname, "index.html"),
        output: {
          strictExecutionOrder: true,
          codeSplitting: {
            // 只分组明确匹配的依赖，保留渲染库的按需加载。
            includeDependenciesRecursively: false,
            groups: Object.entries(vendorChunks).map(([name, packages]) => ({
              name,
              test: (id) =>
                packages.some((dependency) => id.includes(`/node_modules/${dependency}/`)),
            })),
          },
        },
      },
      terserOptions: { compress: { pure_funcs: ["console.log"] } },
      sourcemap: false,
    },
  };
}

export default defineConfig(({ mode }) => createFrontendConfig(mode));

import { resolve } from "node:path";
import { defineConfig, loadEnv, type UserConfig } from "vite";
import { NaiveUiResolver } from "unplugin-vue-components/resolvers";
import vue from "@vitejs/plugin-vue";
import AutoImport from "unplugin-auto-import/vite";
import Components from "unplugin-vue-components/vite";
import viteCompression from "vite-plugin-compression";
import wasm from "vite-plugin-wasm";

// Web 与 mygo 共用渲染配置；旧 Electron 入口仅作为迁移对照保留。
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
    },
    preview: { port, host: "127.0.0.1", strictPort: true },
    build: {
      outDir: desktop ? "dist/desktop" : "dist/web",
      emptyOutDir: true,
      minify: "terser",
      rollupOptions: {
        input: resolve(import.meta.dirname, "index.html"),
        output: {
          manualChunks: {
            "vue-vendor": ["vue", "vue-router", "pinia", "pinia-plugin-persistedstate", "vue-i18n"],
            "naive-ui": ["naive-ui"],
            "vendor-utils": ["lodash-es", "@vueuse/core", "axios", "dayjs", "js-cookie", "md5"],
            "color-theme": [
              "@material/material-color-utilities",
              "@imsyy/color-utils",
              "jss",
              "jss-preset-default",
            ],
            "media-player": ["hls.js", "plyr"],
            markdown: ["marked", "github-markdown-css"],
            pixi: [
              "@pixi/app",
              "@pixi/core",
              "@pixi/display",
              "@pixi/filter-blur",
              "@pixi/filter-bulge-pinch",
              "@pixi/filter-color-matrix",
              "@pixi/sprite",
            ],
            stores: ["src/stores/data.ts", "src/stores/index.ts"],
          },
        },
      },
      terserOptions: { compress: { pure_funcs: ["console.log"] } },
      sourcemap: false,
    },
  };
}

export default defineConfig(({ mode }) => createFrontendConfig(mode));

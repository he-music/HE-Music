import { resolve } from "path";
import { MainEnv } from "./env";
import { defineConfig, externalizeDepsPlugin, loadEnv } from "electron-vite";
import { NaiveUiResolver } from "unplugin-vue-components/resolvers";
import vue from "@vitejs/plugin-vue";
import AutoImport from "unplugin-auto-import/vite";
import Components from "unplugin-vue-components/vite";
import viteCompression from "vite-plugin-compression";
import wasm from "vite-plugin-wasm";

export default defineConfig(({ command, mode }) => {
  // 读取环境变量
  const getEnv = (name: keyof MainEnv): string => {
    return loadEnv(mode, process.cwd())[name];
  };
  console.log(command);
  // 获取端口
  const webPort: number = Number(getEnv("VITE_WEB_PORT") || 14666);
  const servePort: number = Number(getEnv("VITE_SERVER_PORT") || 25666);
  // 返回配置
  return {
    // 主进程
    main: {
      plugins: [externalizeDepsPlugin()],
      build: {
        publicDir: resolve(__dirname, "public"),
        rollupOptions: {
          input: {
            index: resolve(__dirname, "electron/main/index.ts"),
          },
        },
      },
    },
    // 预加载
    preload: {
      plugins: [externalizeDepsPlugin()],
      build: {
        rollupOptions: {
          input: {
            index: resolve(__dirname, "electron/preload/index.ts"),
          },
        },
      },
    },
    // 渲染进程
    renderer: {
      root: ".",
      plugins: [
        vue(),
        AutoImport({
          imports: [
            "vue",
            "vue-router",
            "@vueuse/core",
            {
              "naive-ui": ["useDialog", "useMessage", "useNotification", "useLoadingBar"],
            },
          ],
          eslintrc: {
            enabled: true,
            filepath: "./auto-eslint.mjs",
          },
        }),
        Components({
          resolvers: [NaiveUiResolver()],
        }),
        viteCompression(),
        wasm(),
      ],
      resolve: {
        alias: {
          "@": resolve(__dirname, "src/"),
        },
      },
      css: {
        preprocessorOptions: {
          scss: {
            silenceDeprecations: ["legacy-js-api"],
          },
        },
      },
      server: {
        port: webPort,
        host: "0.0.0.0",
        // 代理
        proxy: {
          "/api": {
            target: `http://127.0.0.1:${servePort}`,
            changeOrigin: true,
            rewrite: (path) => path.replace(/^\/api/, "/api/"),
          },
        },
      },
      preview: {
        port: webPort,
      },
      build: {
        minify: "terser",
        publicDir: resolve(__dirname, "public"),
        rollupOptions: {
          input: {
            index: resolve(__dirname, "index.html"),
            loading: resolve(__dirname, "web/loading/index.html"),
          },
          output: {
            manualChunks: {
              // Vue 生态
              "vue-vendor": [
                "vue",
                "vue-router",
                "pinia",
                "pinia-plugin-persistedstate",
                "vue-i18n",
              ],
              // Naive UI
              "naive-ui": ["naive-ui"],
              // 工具库
              "vendor-utils": ["lodash-es", "@vueuse/core", "axios", "dayjs", "js-cookie", "md5"],
              // 色彩与主题
              "color-theme": [
                "@material/material-color-utilities",
                "@imsyy/color-utils",
                "jss",
                "jss-preset-default",
              ],
              // 媒体播放（按需加载）
              "media-player": ["howler", "hls.js", "plyr"],
              // Markdown 渲染（按需加载）
              markdown: ["marked", "github-markdown-css"],
              // Pixi 歌词特效（按需加载）
              pixi: [
                "@pixi/app",
                "@pixi/core",
                "@pixi/display",
                "@pixi/filter-blur",
                "@pixi/filter-bulge-pinch",
                "@pixi/filter-color-matrix",
                "@pixi/sprite",
              ],
              // Stores
              stores: ["src/stores/data.ts", "src/stores/index.ts"],
            },
          },
        },
        terserOptions: {
          compress: {
            pure_funcs: ["console.log"],
          },
        },
        sourcemap: false,
      },
    },
  };
});

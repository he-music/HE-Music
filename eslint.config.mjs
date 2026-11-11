import js from "@eslint/js";
import typescriptEslint from "@typescript-eslint/eslint-plugin";
import typescriptParser from "@typescript-eslint/parser";
import vue from "eslint-plugin-vue";
import globals from "globals";
import autoEslint from "./auto-eslint.mjs";

export default [
  {
    ignores: [
      "**/node_modules/**",
      "vendor/**",
      "dist/**",
      "build/**",
      "out/**",
      "**/auto-imports.d.ts",
      "**/components.d.ts",
      "src/platform/mygo.bindings.ts",
    ],
  },
  js.configs.recommended,
  ...vue.configs["flat/essential"],
  {
    files: ["**/*.{js,mjs,cjs,ts,vue}"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node, ...autoEslint.globals },
      parserOptions: { ecmaVersion: "latest", sourceType: "module" },
    },
  },
  {
    files: ["**/*.{ts,vue}"],
    plugins: { "@typescript-eslint": typescriptEslint },
    languageOptions: { parserOptions: { parser: typescriptParser, extraFileExtensions: [".vue"] } },
    rules: {
      ...typescriptEslint.configs["eslint-recommended"].overrides[0].rules,
      ...typescriptEslint.configs.recommended.rules,
      "@typescript-eslint/no-explicit-any": "off",
      "vue/multi-word-component-names": "off",
    },
  },
  {
    files: ["**/*.ts"],
    languageOptions: { parser: typescriptParser },
  },
  {
    files: ["desktop/settings_startup_preload.js"],
    languageOptions: { globals: { __SETTINGS_STARTUP_ORIGIN__: "readonly" } },
  },
];

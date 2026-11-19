import { defineConfig } from "vite";
import { createFrontendConfig } from "./vite.config.ts";

export default defineConfig(({ mode }) => createFrontendConfig(mode, true));

import { defineConfig } from "vite";
import { createFrontendConfig } from "./vite.config";

export default defineConfig(({ mode }) => createFrontendConfig(mode, true));

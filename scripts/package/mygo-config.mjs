import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const configFile = "mygo.config.ts";

export async function loadMygoConfig(root = process.cwd(), command = "build") {
  const file = path.join(root, configFile);
  const module = await import(`${pathToFileURL(file).href}?config=${Date.now()}`);
  let config = await module.default;
  if (typeof config === "function") config = await config({ command });
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw new TypeError("mygo.config.ts 必须默认导出配置对象或返回配置对象的函数");
  return config;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = await loadMygoConfig(process.cwd(), "build");
  if (process.argv.includes("--json")) console.log(JSON.stringify(config));
}

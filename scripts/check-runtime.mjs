#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const forbiddenDependencies =
  /^(electron(?:-.+)?|@electron-toolkit\/.+|@neteasecloudmusicapienhanced\/api|@fastify\/.+|fastify|font-list|node-taglib-sharp)$/;
const failures = [];
for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
  if (forbiddenDependencies.test(name)) failures.push(`专用依赖仍存在：${name}`);
}
const bridgePattern =
  /\bwindow\s*\.\s*(?:electron|api)\b|\b(?:isElectron(?:Host)?|electronStartup|createElectronPlatform)\b|(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)["'](?:electron(?:[-/][^"']*)?|@electron-toolkit\/[^"']*)["']/;
async function checkSources(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await checkSources(filename);
    else if (/\.(?:ts|vue)$/.test(entry.name) && !entry.name.endsWith(".test.ts")) {
      const source = await readFile(filename, "utf8");
      if (bridgePattern.test(source))
        failures.push(`旧宿主桥接仍存在：${path.relative(root, filename)}`);
    }
  }
}
await checkSources(path.join(root, "src"));
for (const filename of ["tsconfig.node.json", "tsconfig.web.json"]) {
  if (/electron/i.test(await readFile(path.join(root, filename), "utf8"))) {
    failures.push(`类型配置仍依赖旧宿主：${filename}`);
  }
}
if (/electron(?:-vite|-builder)?\b/.test(JSON.stringify(pkg.scripts))) {
  failures.push("构建命令仍依赖旧宿主");
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Web/mygo 源码、直接依赖和类型配置无 Electron 运行时引用；旧数据兼容格式保留。");
}

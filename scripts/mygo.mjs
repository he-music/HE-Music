#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureMpvResources } from "./mpv/resources.mjs";

/** Only prepare app resources; the official Go tool owns all build behavior. */
export function runMygo(
  args,
  { root = process.cwd(), env = process.env, spawn = spawnSync, prepare = ensureMpvResources } = {},
) {
  if (!new Set(["build", "dev", "generate", "doctor"]).has(args[0])) {
    throw new Error("用法：mygo.mjs build/dev/generate/doctor [官方参数]");
  }
  if (args[0] === "build" || args[0] === "dev") prepare(root, args, env);
  const result = spawn("go", ["tool", "mygo", ...args], {
    cwd: root,
    env: { ...env, GOWORK: "off", GOFLAGS: `${env.GOFLAGS || ""} -mod=readonly`.trim() },
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw new Error("无法运行 Go，请检查工具链");
  return result.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = runMygo(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

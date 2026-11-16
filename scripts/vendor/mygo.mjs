#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { ensureMpvResources } from "../mpv/resources.mjs";
export const SDK_VERSION = "v0.9.0";
export const SDK_WINDOWS_FILE = "github.com/egoist/mygo/internal/windows/window.go";
const lockFile = "scripts/vendor/vendor-lock.json";
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const sourceHash = (text) => sha256(text.replace(/\r\n/g, "\n"));

async function goInputs(root) {
  const mod = await readFile(path.join(root, "go.mod"), "utf8");
  const sum = await readFile(path.join(root, "go.sum"), "utf8");
  if (
    !mod.split(/\r?\n/).some((line) => line.trim() === `github.com/egoist/mygo ${SDK_VERSION}`) ||
    !/^tool github\.com\/egoist\/mygo\/cmd\/mygo\s*$/m.test(mod) ||
    /^\s*replace\b/m.test(mod)
  )
    throw new Error("go.mod 必须固定 mygo SDK/tool 且无 replace");
  return { goModSHA256: sourceHash(mod), goSumSHA256: sourceHash(sum) };
}

export async function vendorFingerprint(directory) {
  if (!(await lstat(directory)).isDirectory()) throw new Error("vendor 必须是普通目录");
  const files = [];
  async function collect(relative) {
    for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      const filename = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await collect(filename);
      else if (entry.isFile()) files.push(filename);
      else throw new Error("vendor 不得包含符号链接或特殊文件");
    }
  }
  await collect("");
  files.sort();
  const hash = createHash("sha256");
  for (const filename of files) {
    const bytes = await readFile(path.join(directory, filename));
    hash.update(`${filename}\0${bytes.length}\0`).update(bytes).update("\0");
  }
  return { fileCount: files.length, treeSHA256: hash.digest("hex") };
}

export async function createVendorLock(root, vendorRoot = path.join(root, "vendor")) {
  return {
    schemaVersion: 2,
    sdkVersion: SDK_VERSION,
    ...(await goInputs(root)),
    ...(await vendorFingerprint(vendorRoot)),
  };
}

export async function verifyVendoredDependencies(root = process.cwd()) {
  const expected = JSON.parse(await readFile(path.join(root, lockFile), "utf8"));
  const actual = await createVendorLock(root);
  if (JSON.stringify(expected) !== JSON.stringify(actual))
    throw new Error("vendor 或 Go 依赖与锁定记录不符，请运行 pnpm vendor:refresh 后审查差异");
  return actual;
}

export async function refreshVendor(root = process.cwd(), spawn = spawnSync) {
  const inputs = await goInputs(root);
  const parent = path.join(root, "build/mygo");
  await mkdir(parent, { recursive: true });
  const stage = await mkdtemp(path.join(parent, "vendor-refresh-"));
  const generated = path.join(stage, "vendor");
  const destination = path.join(root, "vendor");
  const backup = path.join(stage, "previous-vendor");
  let backedUp = false;
  let installed = false;
  let preserveBackup = false;
  try {
    const result = spawn("go", ["mod", "vendor", "-o", generated], {
      cwd: root,
      env: { ...process.env, GOTOOLCHAIN: "local", GOWORK: "off", GOFLAGS: "-mod=readonly" },
      shell: false,
      encoding: "utf8",
      stdio: "pipe",
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) throw new Error("Go vendor 生成失败，原 vendor 保留");
    if (JSON.stringify(await goInputs(root)) !== JSON.stringify(inputs))
      throw new Error("生成期间 Go 依赖已改变，未替换 vendor");
    const lock = await createVendorLock(root, generated);
    const nextLock = path.join(stage, "vendor-lock.json");
    await writeFile(nextLock, JSON.stringify(lock, null, 2) + "\n");
    try {
      const info = await lstat(destination);
      if (!info.isDirectory()) throw new Error("vendor 必须是普通目录");
      await rename(destination, backup);
      backedUp = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      await rename(generated, destination);
      installed = true;
      await rename(nextLock, path.join(root, lockFile));
    } catch (error) {
      preserveBackup = backedUp;
      if (installed) await rm(destination, { recursive: true, force: true });
      if (backedUp) await rename(backup, destination);
      preserveBackup = false;
      throw error;
    }
    return lock;
  } finally {
    if (!preserveBackup) await rm(stage, { recursive: true, force: true });
  }
}

export function vendoredGoEnvironment(env = process.env) {
  return {
    ...env,
    GOTOOLCHAIN: "local",
    GOWORK: "off",
    GOFLAGS: `${env.GOFLAGS || ""} -mod=vendor`.trim(),
  };
}

export async function main(args = process.argv.slice(2), root = process.cwd()) {
  if (args.length === 1 && args[0] === "refresh") {
    console.log(JSON.stringify(await refreshVendor(root), null, 2));
    return;
  }
  await verifyVendoredDependencies(root);
  if (args[0] === "test-windows") {
    const target =
      process.env.GOOS || (process.platform === "win32" ? "windows" : process.platform);
    if (target !== "windows")
      throw new Error("SDK 窗口测试需在 Windows 运行，交叉编译请设置 GOOS=windows");
    const stage = await mkdtemp(path.join(tmpdir(), "he-music-sdk-test-"));
    try {
      const overlay = path.join(stage, "overlay.json");
      await writeFile(
        overlay,
        JSON.stringify({
          Replace: {
            [path.join(
              root,
              "vendor/github.com/egoist/mygo/internal/windows/window_frame_test.go",
            )]: path.join(root, "scripts/vendor/_tests/window_frame_test.go"),
          },
        }),
      );
      const result = spawnSync(
        "go",
        [
          "test",
          `-overlay=${overlay}`,
          ...args.slice(1),
          "github.com/egoist/mygo/internal/windows",
        ],
        {
          cwd: root,
          env: vendoredGoEnvironment(),
          stdio: "inherit",
          shell: false,
        },
      );
      if (result.error) throw new Error("无法运行 Go 窗口测试");
      process.exitCode = result.status ?? 1;
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
    return;
  }
  if (args.length === 1 && args[0] === "check") {
    console.log("固定 SDK、Go 依赖及 vendor 全量摘要校验通过");
    return;
  }
  if (!new Set(["build", "dev", "generate", "doctor"]).has(args[0]))
    throw new Error(
      "用法：mygo.mjs check | refresh | test-windows | build/dev/generate/doctor [官方参数]",
    );
  if (args[0] === "build" || args[0] === "dev") ensureMpvResources(root, args);
  const result = spawnSync("go", ["tool", "mygo", ...args], {
    cwd: root,
    env: vendoredGoEnvironment(),
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw new Error("无法运行 Go，请检查工具链");
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

#!/usr/bin/env node
// 开发/CI 发布工具；不属于应用运行时。协议来源：mygo 07ebe19ac0dc。
import { createHash, createPrivateKey, createPublicKey, verify } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const SDK_VERSION = "v0.6.5-0.20261026063203-07ebe19ac0dc";
const targetsAllowed = new Set([
  "darwin/arm64",
  "darwin/amd64",
  "darwin/universal",
  "linux/arm64",
  "linux/amd64",
  "windows/arm64",
  "windows/amd64",
]);
const versionPattern =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const publicPrefix = Buffer.from("302a300506032b6570032100", "hex");
const privatePrefix = Buffer.from("302e020100300506032b657004220420", "hex");
class ReleaseError extends Error {}
const fail = (message) => {
  throw new ReleaseError(message);
};
const text = (value) => typeof value === "string" && value.length > 0;

function decodeBase64(value, size, label) {
  if (typeof value !== "string") fail(`${label} 格式无效`);
  // Go StdEncoding 只忽略 CR/LF，签名不得 trim 首尾 space/tab。
  const normalized = value.replace(/[\r\n]/g, "");
  const bytes = Buffer.from(normalized, "base64");
  if (bytes.length !== size || bytes.toString("base64") !== normalized) fail(`${label} 格式无效`);
  return bytes;
}

function decodeKey(value, size, label) {
  // SDK ParsePublicKey/ParsePrivateKey 对密钥文本先 TrimSpace。
  return decodeBase64(typeof value === "string" ? value.trim() : value, size, label);
}

function decodeSignature(value, label = "signature") {
  return decodeBase64(value, 64, label);
}

function validVersion(value) {
  if (!text(value) || !versionPattern.test(value)) fail("版本必须是明确的语义版本");
}

function validateTargets(targets) {
  if (
    !Array.isArray(targets) ||
    targets.length === 0 ||
    new Set(targets).size !== targets.length ||
    targets.some((target) => !targetsAllowed.has(target))
  )
    fail("目标必须是受支持且不重复的 GOOS/GOARCH");
}

function httpsURL(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${label} 必须是 HTTPS URL`);
  }
  if (
    typeof value !== "string" ||
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    value.trim() !== value
  )
    fail(`${label} 必须是无凭据、查询和片段的 HTTPS URL`);
  return url;
}

export function validateConfig(config) {
  if (!config || typeof config !== "object") fail("mygo.json 配置无效");
  const u = config.updates;
  if (!u || typeof u !== "object") fail("updates 未配置，自动更新不可用；请先配置真实 feed 和公钥");
  decodeKey(u.publicKey, 32, "updates.publicKey");
  if (Object.hasOwn(u, "privateKey"))
    fail("禁止 updates.privateKey；私钥只能通过 MYGO_UPDATER_PRIVATE_KEY 注入");
  if (Boolean(u.github) === Boolean(u.url)) fail("updates 必须且只能配置 github 或 url");
  if (
    u.github &&
    (typeof u.github !== "string" ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(u.github) ||
      u.github.split("/").some((p) => p === "." || p === ".."))
  )
    fail("updates.github 必须是 owner/repo");
  if (u.url) httpsURL(u.url, "updates.url");
  if (u.tagPrefix !== undefined && (typeof u.tagPrefix !== "string" || /[\s/?#]/.test(u.tagPrefix)))
    fail("updates.tagPrefix 无效");
  if (u.deltas !== undefined && (!Number.isSafeInteger(u.deltas) || u.deltas < 0))
    fail("updates.deltas 必须是非负整数");
  validVersion(config.version);
  if (!text(config.slug) || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(config.slug))
    fail("必须明确配置合法 slug");
  if (
    !text(config.out) ||
    path.isAbsolute(config.out) ||
    config.out.split(/[\\/]/).some((part) => part === "..") ||
    path.normalize(config.out) === "."
  )
    fail("out 必须是项目内的独立相对目录");
  return config;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function validateOutputDirectory(config, root) {
  const projectRoot = await realpath(root);
  const out = path.resolve(root, config.out);
  const parts = path.relative(path.resolve(root), out).split(path.sep);
  let current = projectRoot;
  for (let index = 0; index < parts.length; index++) {
    const candidate = path.join(current, parts[index]);
    let info;
    try {
      info = await lstat(candidate);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      // 尚未创建的后缀只能接在已验证的项目内祖先上，不创建目录。
      current = path.resolve(current, ...parts.slice(index));
      if (!inside(projectRoot, current)) fail("out 必须位于项目内");
      break;
    }
    let resolved;
    try {
      resolved = await realpath(candidate);
    } catch {
      fail("out 的已有祖先必须是可解析的项目内目录");
    }
    if (!inside(projectRoot, resolved)) fail("out 的已有祖先必须位于项目内");
    if (!(info.isSymbolicLink() ? await lstat(resolved) : info).isDirectory())
      fail("out 的已有祖先必须是项目内目录");
    current = resolved;
  }
  if (current === projectRoot) fail("out 必须是项目内的独立目录");
  return out;
}

function signingKey(config, env) {
  const raw = decodeKey(env.MYGO_UPDATER_PRIVATE_KEY, 64, "MYGO_UPDATER_PRIVATE_KEY");
  const key = createPrivateKey({
    key: Buffer.concat([privatePrefix, raw.subarray(0, 32)]),
    format: "der",
    type: "pkcs8",
  });
  const derived = createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32);
  if (
    !derived.equals(raw.subarray(32)) ||
    !derived.equals(decodeKey(config.updates.publicKey, 32, "updates.publicKey"))
  )
    fail("更新私钥与 updates.publicKey 不匹配");
}

// 与 Go net/url.PathEscape 的 encodePathSegment 字节集合一致，包括未转义的 +。
function pathEscape(value) {
  return Array.from(Buffer.from(value), (byte) => {
    const char = String.fromCharCode(byte);
    return /[A-Za-z0-9_.~$&+:=@-]/.test(char)
      ? char
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }).join("");
}

function artifactURL(config, name) {
  const u = config.updates;
  if (u.github)
    return `https://github.com/${u.github}/releases/download/${pathEscape((u.tagPrefix || "v") + config.version)}/${pathEscape(name)}`;
  return `${u.url.replace(/\/$/, "")}/${pathEscape(name)}`;
}

async function regularFileInside(root, file) {
  const info = await lstat(file);
  const actualRoot = await realpath(root);
  const actual = await realpath(file);
  if (!info.isFile() || !inside(actualRoot, actual)) fail("产物必须是输出目录内的普通文件");
  return info;
}

async function verifyFile(config, root, dir, entry, name, publicKey) {
  if (!entry || typeof entry !== "object" || entry.url !== artifactURL(config, name))
    fail("产物 URL 与配置、版本或目标不匹配");
  httpsURL(entry.url, "产物 URL");
  if (!Number.isSafeInteger(entry.size) || entry.size <= 0 || entry.size > 1 << 30)
    fail("产物 size 无效或超过 SDK 1GiB 限制");
  const signature = decodeSignature(entry.signature);
  const file = path.join(dir, name);
  const before = await regularFileInside(root, file);
  if (before.size !== entry.size) fail("产物 size 与真实文件不符");
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  const hash = digest.digest();
  const after = await lstat(file);
  if (
    before.ino !== after.ino ||
    before.dev !== after.dev ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  )
    fail("验签期间产物发生变化");
  if (!verify(null, hash, publicKey, signature)) fail("产物 SHA-256 digest 签名不匹配");
  return { file, size: entry.size, sha256: hash.toString("hex") };
}

export async function verifyArtifacts(config, root, targets) {
  validateConfig(config);
  validateTargets(targets);
  const out = await validateOutputDirectory(config, root);
  const publicKey = createPublicKey({
    key: Buffer.concat([
      publicPrefix,
      decodeKey(config.updates.publicKey, 32, "updates.publicKey"),
    ]),
    format: "der",
    type: "spki",
  });
  const results = [];
  for (const platform of targets) {
    const target = platform.replace("/", "-");
    const dir = path.join(out, target);
    const manifestFile = path.join(dir, `update-${target}.json`);
    const info = await regularFileInside(out, manifestFile);
    if (info.size > 1 << 20) fail("manifest 超过 SDK 1MiB 限制");
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    } catch {
      fail("manifest JSON 无效");
    }
    if (!manifest || manifest.version !== config.version) fail("manifest 版本与发布版本不符");
    if (
      manifest.date !== undefined &&
      (typeof manifest.date !== "string" ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(manifest.date) ||
        Number.isNaN(Date.parse(manifest.date)))
    )
      fail("manifest date 必须是 RFC3339");
    if (manifest.notes !== undefined && typeof manifest.notes !== "string")
      fail("manifest notes 必须是文本");
    results.push(
      await verifyFile(
        config,
        out,
        dir,
        manifest,
        `${config.slug}-${config.version}-${target}.tar.gz`,
        publicKey,
      ),
    );
    if (manifest.deltas !== undefined && !Array.isArray(manifest.deltas))
      fail("manifest deltas 必须是数组");
    const seen = new Set();
    for (const delta of manifest.deltas || []) {
      validVersion(delta?.from);
      if (delta.from === config.version || seen.has(delta.from)) fail("delta from 无效或重复");
      seen.add(delta.from);
      results.push(
        await verifyFile(
          config,
          out,
          dir,
          delta,
          `${config.slug}-${delta.from}-to-${config.version}-${target}.delta`,
          publicKey,
        ),
      );
    }
    // previous 是官方供下一次构建使用的远端历史引用，不是本次待发布文件。
    if (manifest.previous !== undefined && !Array.isArray(manifest.previous))
      fail("manifest previous 必须是数组");
    for (const previous of manifest.previous || []) {
      validVersion(previous?.version);
      httpsURL(previous.url, "previous URL");
      decodeSignature(previous.signature, "previous signature");
      if (!Number.isSafeInteger(previous.size) || previous.size <= 0 || previous.size > 1 << 30)
        fail("previous size 无效");
    }
  }
  return results;
}

export async function runRelease({
  root = process.cwd(),
  mode = "check-only",
  targets = ["darwin/arm64"],
  env = process.env,
  spawn = spawnSync,
} = {}) {
  validateTargets(targets);
  if (!["check-only", "verify-artifacts", "build"].includes(mode)) fail("模式无效");
  let config;
  try {
    config = JSON.parse(await readFile(path.join(root, "mygo.json"), "utf8"));
  } catch {
    fail("无法读取合法 mygo.json");
  }
  validateConfig(config);
  if (mode === "check-only") {
    await validateOutputDirectory(config, root);
    return { mode, version: config.version, targets };
  }
  if (mode === "build") {
    signingKey(config, env);
    const goMod = await readFile(path.join(root, "go.mod"), "utf8");
    if (
      !goMod.split("\n").some((line) => line.trim() === `github.com/egoist/mygo ${SDK_VERSION}`) ||
      !/^tool github\.com\/egoist\/mygo\/cmd\/mygo\s*$/m.test(goMod) ||
      /^\s*replace\b/m.test(goMod)
    )
      fail("go.mod 必须使用固定 mygo SDK/tool 且无 replace");
    try {
      await lstat(path.join(root, "mygo.config.ts"));
      fail("只支持单一 mygo.json；请移除并行 TS 配置");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await validateOutputDirectory(config, root);
    const args = ["tool", "mygo", "build", "-platform", targets.join(",")];
    if (targets.some((target) => target.startsWith("darwin/")))
      args.push("-sign", "-", "-skip-notarize");
    // 不转发构建 stdout/stderr：下游命令可能意外打印环境中的 secret。
    let result;
    try {
      result = spawn("go", args, {
        cwd: root,
        env: { ...env, GOTOOLCHAIN: "local", GOWORK: "off", GOFLAGS: "-mod=readonly" },
        shell: false,
        encoding: "utf8",
        stdio: "pipe",
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch {
      fail("mygo 构建失败；未输出下游日志以保护私钥");
    }
    if (!result || result.error || result.status !== 0)
      fail("mygo 构建失败；未输出下游日志以保护私钥");
  }
  return {
    mode,
    version: config.version,
    targets,
    artifacts: await verifyArtifacts(config, root, targets),
  };
}

export async function main(argv = process.argv.slice(2)) {
  let mode = "check-only";
  let modeChosen = false;
  let targets = ["darwin/arm64"];
  let targetChosen = false;
  for (let i = 0; i < argv.length; i++) {
    if (["--check-only", "--verify-artifacts", "--build"].includes(argv[i])) {
      if (modeChosen) fail("只能选择一个模式");
      mode = argv[i].slice(2);
      modeChosen = true;
    } else if (argv[i] === "--platform" && argv[i + 1] && !targetChosen) {
      targets = argv[++i].split(",");
      targetChosen = true;
    } else
      fail(
        "未知或缺值参数；使用 --check-only / --verify-artifacts / --build 和 --platform GOOS/GOARCH",
      );
  }
  const result = await runRelease({ mode, targets });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // 文件错误可能含用户路径，因此只输出固定的受控错误，绝不输出下游日志。
    console.error(
      error instanceof ReleaseError
        ? error.message
        : "mygo 发布校验失败：文件不可读或加密操作失败；未输出底层日志以保护私钥。",
    );
    process.exitCode = 1;
  });
}

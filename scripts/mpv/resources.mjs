import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const allowed = new Set(
  ["darwin", "linux", "windows"].flatMap((os) => ["amd64", "arm64"].map((arch) => `${os}/${arch}`)),
);
allowed.add("darwin/universal");

export function mpvTargets(args, env = process.env, host = process) {
  const index = args.indexOf("-platform");
  const inline = args.find((arg) => arg.startsWith("-platform="));
  const system = env.GOOS || (host.platform === "win32" ? "windows" : host.platform);
  const architecture = env.GOARCH || (host.arch === "x64" ? "amd64" : host.arch);
  const value =
    index >= 0
      ? args[index + 1]
      : inline !== undefined
        ? inline.slice(10)
        : `${system}/${architecture}`;
  const targets = value?.split(",");
  if (!targets?.length || targets.some((target) => !allowed.has(target))) {
    throw new Error("libmpv 资源准备需要明确且受支持的 GOOS/GOARCH");
  }
  return [...new Set(targets)];
}

export function runMpvTool(root, args, env = process.env, spawn = spawnSync) {
  const python = env.MPV_PYTHON || (process.platform === "win32" ? "python" : "python3");
  // 资源准备不需要发布私钥。
  const buildEnv = { ...env };
  delete buildEnv.MYGO_UPDATER_PRIVATE_KEY;
  const result = spawn(python, [path.join(root, "scripts/mpv/download.py"), ...args], {
    cwd: root,
    env: buildEnv,
    stdio: "inherit",
    shell: false,
  });
  if (result.error || result.status !== 0) {
    throw new Error("随包 libmpv 准备/校验失败；请查看资源日志和 scripts/mpv/README.md");
  }
}

export function ensureMpvResources(root, args, env = process.env, spawn = spawnSync) {
  const targets = mpvTargets(args, env);
  runMpvTool(
    root,
    ["--target", targets.join(","), ...(env.MPV_OFFLINE === "1" ? ["--offline"] : [])],
    env,
    spawn,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runMpvTool(process.cwd(), process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { ensureMpvResources, mpvTargets } from "./resources.mjs";

test("资源目标准确覆盖官方多平台参数、主机默认值与 Go 环境", () => {
  assert.deepEqual(mpvTargets(["build", "-platform", "windows/amd64,windows/arm64"], {}), [
    "windows/amd64",
    "windows/arm64",
  ]);
  assert.deepEqual(mpvTargets(["build", "-platform=darwin/universal"], {}), ["darwin/universal"]);
  assert.deepEqual(mpvTargets(["dev"], {}, { platform: "win32", arch: "x64" }), ["windows/amd64"]);
  assert.deepEqual(mpvTargets(["build"], { GOOS: "linux", GOARCH: "arm64" }), ["linux/arm64"]);
  for (const args of [["-platform"], ["-platform", "linux/386"], ["-platform", "../escape"]]) {
    assert.throws(() => mpvTargets(args, {}), /受支持/);
  }
});

test("正常构建准备库且不将发布私钥传入构建工具，支持离线缓存", () => {
  const calls = [];
  const env = {
    GOOS: "linux",
    GOARCH: "amd64",
    PATH: "existing",
    MPV_OFFLINE: "1",
    MYGO_UPDATER_PRIVATE_KEY: "fixture-secret",
  };
  ensureMpvResources("/project 空格", ["build"], env, (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0 };
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [
    path.join("/project 空格", "scripts/mpv/download.py"),
    "--target",
    "linux/amd64",
    "--offline",
  ]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.env.MYGO_UPDATER_PRIVATE_KEY, undefined);
  assert.equal(env.MYGO_UPDATER_PRIVATE_KEY, "fixture-secret");
  assert.equal(calls[0].options.env.PATH, "existing");
});

test("准备失败或 Python 缺失时阻止继续打包，不把失败当成缺少可选引擎", () => {
  for (const result of [{ status: 7 }, { status: null, error: new Error("missing python") }]) {
    assert.throws(
      () =>
        ensureMpvResources(
          "/project",
          ["build", "-platform", "darwin/universal"],
          {},
          () => result,
        ),
      /准备\/校验失败/,
    );
  }
});

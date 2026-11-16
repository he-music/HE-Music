import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  refreshVendor,
  SDK_VERSION,
  SDK_WINDOWS_FILE,
  vendorFingerprint,
  vendoredGoEnvironment,
  verifyVendoredDependencies,
} from "./mygo.mjs";
import { vendorFixture } from "./fixture.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "he-music vendor "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, "go.mod"),
    `module fixture\nrequire (\n github.com/egoist/mygo ${SDK_VERSION}\n)\ntool github.com/egoist/mygo/cmd/mygo\n`,
  );
  return { root, ...(await vendorFixture(root)) };
}

function generateFixture(f, args) {
  const file = path.join(args[3], SDK_WINDOWS_FILE);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, f.source);
  writeFileSync(path.join(args[3], "fixture.txt"), "offline dependency fixture\n");
}

test("上游 SDK 无本地补丁时，任意依赖篡改和 Go 依赖漂移仍被拒绝", async (t) => {
  const f = await fixture(t);
  assert.equal(f.lock.sdkVersion, "v0.9.0");
  assert.equal(f.lock.schemaVersion, 2);
  assert.equal(Object.hasOwn(f.lock, "patchId"), false);
  assert.deepEqual(await verifyVendoredDependencies(f.root), f.lock);
  await writeFile(path.join(f.root, "vendor/fixture.txt"), "changed dependency");
  await assert.rejects(verifyVendoredDependencies(f.root), /锁定记录/);
  await writeFile(path.join(f.root, "vendor/fixture.txt"), "offline dependency fixture\n");
  await writeFile(path.join(f.root, "vendor", SDK_WINDOWS_FILE), "modified upstream SDK");
  await assert.rejects(verifyVendoredDependencies(f.root), /锁定记录/);
  await writeFile(path.join(f.root, "vendor", SDK_WINDOWS_FILE), f.source);
  await writeFile(path.join(f.root, "go.sum"), "changed checksum\n");
  await assert.rejects(verifyVendoredDependencies(f.root), /锁定记录/);
});

test("刷新保留官方源码原始字节并产生相同锁定记录", async (t) => {
  const f = await fixture(t);
  const spawn = (command, args, options) => {
    assert.equal(command, "go");
    assert.deepEqual(args.slice(0, 3), ["mod", "vendor", "-o"]);
    assert.equal(options.env.GOWORK, "off");
    assert.equal(options.env.GOFLAGS, "-mod=readonly");
    generateFixture(f, args);
    return { status: 0 };
  };
  assert.deepEqual(await refreshVendor(f.root, spawn), f.lock);
  assert.deepEqual(await verifyVendoredDependencies(f.root), f.lock);
});

test("生成失败时不替换现有 vendor", async (t) => {
  const f = await fixture(t);
  const before = await vendorFingerprint(path.join(f.root, "vendor"));
  await assert.rejects(
    refreshVendor(f.root, () => ({ status: 1 })),
    /原 vendor 保留/,
  );
  assert.deepEqual(await vendorFingerprint(path.join(f.root, "vendor")), before);
  assert.deepEqual(await verifyVendoredDependencies(f.root), f.lock);
});

test("生成期间 Go 依赖改变时拒绝替换 vendor", async (t) => {
  const f = await fixture(t);
  const before = await vendorFingerprint(path.join(f.root, "vendor"));
  await assert.rejects(
    refreshVendor(f.root, (_command, args) => {
      generateFixture(f, args);
      writeFileSync(path.join(f.root, "go.sum"), "changed during generation\n");
      return { status: 0 };
    }),
    /生成期间 Go 依赖已改变/,
  );
  assert.deepEqual(await vendorFingerprint(path.join(f.root, "vendor")), before);
});

test("写入新锁定记录失败时回滚 vendor", async (t) => {
  const f = await fixture(t);
  const before = await vendorFingerprint(path.join(f.root, "vendor"));
  const lockPath = path.join(f.root, "scripts/vendor/vendor-lock.json");
  await rm(lockPath);
  mkdirSync(lockPath);
  writeFileSync(path.join(lockPath, "blocker"), "synthetic lock commit failure");
  await assert.rejects(
    refreshVendor(f.root, (_command, args) => {
      generateFixture(f, args);
      writeFileSync(path.join(args[3], "fixture.txt"), "new generated dependency\n");
      return { status: 0 };
    }),
  );
  assert.deepEqual(await vendorFingerprint(path.join(f.root, "vendor")), before);
});

test("vendor 不得包含符号链接", async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.root, "outside.txt");
  await writeFile(outside, "outside");
  await symlink(outside, path.join(f.root, "vendor/linked.txt"));
  await assert.rejects(verifyVendoredDependencies(f.root), /符号链接/);
});

test("Go 构建固定 vendor 模式并保留已有编译标签", () => {
  const env = vendoredGoEnvironment({
    GOFLAGS: "-tags=nativeprobe -mod=readonly",
    GOWORK: "untrusted-workspace",
  });
  assert.equal(env.GOFLAGS, "-tags=nativeprobe -mod=readonly -mod=vendor");
  assert.equal(env.GOWORK, "off");
  assert.equal(env.GOTOOLCHAIN, "local");
});

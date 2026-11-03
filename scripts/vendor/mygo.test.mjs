import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applySDKPatch,
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

const originalSource = (f) =>
  [
    { before: f.definition.patch.before, after: f.definition.patch.after },
    ...(f.definition.patch.additionalEdits || []),
  ]
    .reverse()
    .reduce((source, edit) => source.replace(edit.after, edit.before), f.source.toString("utf8"));

test("补丁只接受固定的上游字节，结果与固定边框候选摘要一致", async (t) => {
  const f = await fixture(t);
  const sdkFile = path.join(f.root, "vendor", SDK_WINDOWS_FILE);
  await writeFile(sdkFile, originalSource(f));
  await applySDKPatch(path.join(f.root, "vendor"), f.definition);
  assert.deepEqual(await readFile(sdkFile), f.source);
  await assert.rejects(applySDKPatch(path.join(f.root, "vendor"), f.definition), /上游源码摘要/);
  assert.deepEqual(await readFile(sdkFile), f.source);
});

test("边框附加补丁上下文失败时不留下部分透明修正", async (t) => {
  const f = await fixture(t);
  const sdkFile = path.join(f.root, "vendor", SDK_WINDOWS_FILE);
  const original = Buffer.from(originalSource(f));
  await writeFile(sdkFile, original);
  const definition = structuredClone(f.definition);
  definition.patch.additionalEdits[0].before = "missing native frame context";
  await assert.rejects(applySDKPatch(path.join(f.root, "vendor"), definition), /上下文不唯一/);
  assert.deepEqual(await readFile(sdkFile), original);
  definition.patch.additionalEdits = "invalid";
  await assert.rejects(applySDKPatch(path.join(f.root, "vendor"), definition), /附加补丁/);
  assert.deepEqual(await readFile(sdkFile), original);
});

test("已提交 vendor 可离线校验，任意依赖改动、缺补丁与 Go 依赖漂移均被拒绝", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await verifyVendoredDependencies(f.root), f.lock);
  await writeFile(path.join(f.root, "vendor/fixture.txt"), "changed dependency");
  await assert.rejects(verifyVendoredDependencies(f.root), /锁定记录/);
  await writeFile(path.join(f.root, "vendor/fixture.txt"), "offline dependency fixture\n");
  await writeFile(path.join(f.root, "vendor", SDK_WINDOWS_FILE), originalSource(f));
  await assert.rejects(verifyVendoredDependencies(f.root), /透明补丁缺失/);
  await writeFile(path.join(f.root, "vendor", SDK_WINDOWS_FILE), f.source);
  await writeFile(path.join(f.root, "go.sum"), "changed checksum\n");
  await assert.rejects(verifyVendoredDependencies(f.root), /锁定记录/);
});

test("上游漂移时刷新拒绝替换现有 vendor", async (t) => {
  const f = await fixture(t);
  const before = await vendorFingerprint(path.join(f.root, "vendor"));
  const spawn = (command, args, options) => {
    assert.equal(command, "go");
    assert.deepEqual(args.slice(0, 3), ["mod", "vendor", "-o"]);
    assert.equal(options.env.GOWORK, "off");
    assert.equal(options.env.GOFLAGS, "-mod=readonly");
    const file = path.join(args[3], SDK_WINDOWS_FILE);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "unexpected upstream SDK");
    return { status: 0 };
  };
  await assert.rejects(refreshVendor(f.root, spawn), /上游源码摘要/);
  assert.deepEqual(await vendorFingerprint(path.join(f.root, "vendor")), before);
  assert.deepEqual(await verifyVendoredDependencies(f.root), f.lock);
});

test("刷新从原始字节重放补丁，保留固定 Go 依赖并生成同一锁定记录", async (t) => {
  const f = await fixture(t);
  const spawn = (_command, args) => {
    const file = path.join(args[3], SDK_WINDOWS_FILE);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, originalSource(f));
    writeFileSync(path.join(args[3], "fixture.txt"), "offline dependency fixture\n");
    return { status: 0 };
  };
  assert.deepEqual(await refreshVendor(f.root, spawn), f.lock);
  assert.deepEqual(await verifyVendoredDependencies(f.root), f.lock);
});

test("写入新锁定记录失败时回滚 vendor，不留下半更新依赖", async (t) => {
  const f = await fixture(t);
  const before = await vendorFingerprint(path.join(f.root, "vendor"));
  const lockPath = path.join(f.root, "patches/mygo/vendor-lock.json");
  await rm(lockPath);
  mkdirSync(lockPath);
  writeFileSync(path.join(lockPath, "blocker"), "synthetic lock commit failure");
  const spawn = (_command, args) => {
    const file = path.join(args[3], SDK_WINDOWS_FILE);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, originalSource(f));
    writeFileSync(path.join(args[3], "fixture.txt"), "new generated dependency\n");
    return { status: 0 };
  };
  await assert.rejects(refreshVendor(f.root, spawn));
  assert.deepEqual(await vendorFingerprint(path.join(f.root, "vendor")), before);
});

test("vendor 不得通过符号链接读取项目外的内容", async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.root, "outside.txt");
  await writeFile(outside, "outside");
  await symlink(outside, path.join(f.root, "vendor/linked.txt"));
  await assert.rejects(verifyVendoredDependencies(f.root), /符号链接/);
});

test("Go 构建固定 vendor 模式，同时保留已有编译标签", () => {
  const env = vendoredGoEnvironment({
    GOFLAGS: "-tags=nativeprobe -mod=readonly",
    GOWORK: "untrusted-workspace",
  });
  assert.equal(env.GOFLAGS, "-tags=nativeprobe -mod=readonly -mod=vendor");
  assert.equal(env.GOWORK, "off");
  assert.equal(env.GOTOOLCHAIN, "local");
});

import assert from "node:assert/strict";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { main, SDK_VERSION, validateConfig, verifyArtifacts, runRelease } from "./mygo-release.mjs";
import { vendorFixture } from "../vendor/fixture.mjs";

const pair = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  return {
    privateKey,
    pub: pub.toString("base64"),
    secret: Buffer.concat([seed, pub]).toString("base64"),
  };
};
const keys = pair();
const config = () => ({
  slug: "he-music",
  version: "1.0.4",
  out: "build/mygo",
  updates: { publicKey: keys.pub, url: "https://downloads.example.test/music" },
});
const env = { MYGO_UPDATER_PRIVATE_KEY: keys.secret };
const goMod = `module fixture\nrequire (\n github.com/egoist/mygo ${SDK_VERSION}\n)\ntool github.com/egoist/mygo/cmd/mygo\n`;

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "mygo-release-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const c = config();
  await writeFile(path.join(root, "mygo.json"), JSON.stringify(c));
  await writeFile(path.join(root, "go.mod"), goMod);
  await vendorFixture(root);
  const dir = path.join(root, c.out, "darwin-arm64");
  await mkdir(dir, { recursive: true });
  const archive = Buffer.from("offline test archive bytes");
  const name = "he-music-1.0.4-darwin-arm64.tar.gz";
  await writeFile(path.join(dir, name), archive);
  const manifest = {
    version: c.version,
    date: "2026-10-26T00:00:00Z",
    url: `${c.updates.url}/${name}`,
    size: archive.length,
    signature: sign(null, createHash("sha256").update(archive).digest(), keys.privateKey).toString(
      "base64",
    ),
  };
  const manifestPath = path.join(dir, "update-darwin-arm64.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  return { root, c, dir, name, manifest, manifestPath };
}

test("默认缺更新配置拒绝，公开配置检查不需要私钥", () => {
  assert.throws(() => validateConfig({ version: "1.0.4", slug: "he-music" }), /updates 未配置/);
  assert.doesNotThrow(() => validateConfig(config()));
  for (const updates of [
    { publicKey: keys.pub },
    { ...config().updates, github: "owner/repo" },
    { publicKey: keys.pub, url: "http://example.test" },
    { publicKey: keys.pub, github: "/repo" },
    { ...config().updates, publicKey: "bad" },
    { ...config().updates, privateKey: "secret.key" },
    { ...config().updates, deltas: -1 },
    { ...config().updates, url: "https://user:pass@example.test/path" },
  ]) {
    assert.throws(() => validateConfig({ ...config(), updates }));
  }
  for (const change of [{ out: "../escape" }, { slug: "../../bad" }, { version: "bad" }])
    assert.throws(() => validateConfig({ ...config(), ...change }));
  assert.doesNotThrow(() =>
    validateConfig({ ...config(), updates: { publicKey: keys.pub, github: "owner/repo" } }),
  );
});

test("构建前拒绝缺失、不匹配或损坏私钥，不回显 secret", async (t) => {
  const { root } = await fixture(t);
  let calls = 0;
  for (const secret of [undefined, "bad", pair().secret, Buffer.alloc(64).toString("base64")]) {
    await assert.rejects(
      runRelease({
        root,
        mode: "build",
        targets: ["darwin/arm64"],
        env: { MYGO_UPDATER_PRIVATE_KEY: secret },
        spawn: () => {
          calls++;
        },
      }),
      (error) => !error.message.includes(secret || "impossible-secret"),
    );
  }
  assert.equal(calls, 0);
});

test("验签真实 bytes，拒绝损坏、错误目标、版本、大小、URL 和 signature", async (t) => {
  const f = await fixture(t);
  assert.equal((await verifyArtifacts(f.c, f.root, ["darwin/arm64"])).length, 1);
  for (const change of [
    { version: "1.0.3" },
    { size: f.manifest.size + 1 },
    { signature: "bad" },
    { url: f.manifest.url.replace("darwin-arm64", "darwin-amd64") },
    { url: f.manifest.url.replace("https:", "http:") },
    { url: f.manifest.url.replace("downloads.example.test", "elsewhere.test") },
    { date: "bad" },
    { notes: 3 },
    { deltas: {} },
    { size: 2 ** 31 },
  ]) {
    await writeFile(f.manifestPath, JSON.stringify({ ...f.manifest, ...change }));
    await assert.rejects(verifyArtifacts(f.c, f.root, ["darwin/arm64"]));
  }
  await writeFile(f.manifestPath, JSON.stringify(f.manifest));
  await writeFile(path.join(f.dir, f.name), Buffer.alloc(f.manifest.size));
  await assert.rejects(verifyArtifacts(f.c, f.root, ["darwin/arm64"]), /签名/);
  await assert.rejects(verifyArtifacts(f.c, f.root, ["darwin/amd64"]));
});

test("仅官方参数构建，ad hoc/跳过公证；离线模式零 spawn", async (t) => {
  const { root } = await fixture(t);
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0 };
  };
  await runRelease({ root, mode: "check-only", targets: ["darwin/arm64"], env: {}, spawn });
  await runRelease({ root, mode: "verify-artifacts", targets: ["darwin/arm64"], env: {}, spawn });
  assert.equal(calls.length, 0);
  await runRelease({ root, mode: "build", targets: ["darwin/arm64"], env, spawn });
  assert.equal(calls[0].command, "go");
  assert.deepEqual(calls[0].args, [
    "tool",
    "mygo",
    "build",
    "-platform",
    "darwin/arm64",
    "-sign",
    "-",
    "-skip-notarize",
  ]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.cwd, root);
  assert.equal(calls[0].options.stdio, "pipe");
  assert.equal(calls[0].options.env.GOWORK, "off");
  assert.equal(calls[0].options.env.GOTOOLCHAIN, "local");
  assert.equal(calls[0].options.env.GOFLAGS, "-mod=vendor");
  await assert.rejects(
    runRelease({
      root,
      mode: "build",
      targets: ["darwin/arm64"],
      env,
      spawn: () => ({ status: 2, stderr: keys.secret }),
    }),
    /构建失败/,
  );
  await assert.rejects(runRelease({ root, mode: "build", targets: ["../bad"], env, spawn }));
  await assert.rejects(runRelease({ root, targets: ["darwin/arm64", "darwin/arm64"], spawn }));
});
test("vendor 被修改或缺失时，发布构建在调用 Go 前拒绝", async (t) => {
  const { root } = await fixture(t);
  let calls = 0;
  const spawn = () => {
    calls++;
    return { status: 0 };
  };
  await writeFile(path.join(root, "vendor/fixture.txt"), "changed dependency");
  await assert.rejects(runRelease({ root, mode: "build", env, spawn }), /vendor/);
  await rm(path.join(root, "vendor"), { recursive: true });
  await assert.rejects(runRelease({ root, mode: "build", env, spawn }), /vendor/);
  assert.equal(calls, 0);
});

test("拒绝 SDK 漂移、replace 与并行 TS 配置，零 spawn", async (t) => {
  const { root } = await fixture(t);
  let calls = 0;
  const spawn = () => {
    calls++;
    return { status: 0 };
  };
  for (const mod of [goMod.replace(SDK_VERSION, "v0.0.0"), `${goMod}replace x => y\n`]) {
    await writeFile(path.join(root, "go.mod"), mod);
    await assert.rejects(runRelease({ root, mode: "build", env, spawn }), /固定 mygo/);
  }
  await writeFile(path.join(root, "go.mod"), goMod);
  await writeFile(path.join(root, "mygo.config.ts"), "not executed");
  await assert.rejects(runRelease({ root, mode: "build", env, spawn }), /单一 mygo.json/);
  assert.equal(calls, 0);
});

test("GitHub tagPrefix URL 和 delta 同样验签，previous 仅历史引用", async (t) => {
  const f = await fixture(t);
  f.c.updates = { publicKey: keys.pub, github: "owner/repo", tagPrefix: "desktop-v" };
  f.manifest.url = `https://github.com/owner/repo/releases/download/desktop-v1.0.4/${f.name}`;
  const deltaName = "he-music-1.0.3-to-1.0.4-darwin-arm64.delta";
  const bytes = Buffer.from("test delta");
  await writeFile(path.join(f.dir, deltaName), bytes);
  f.manifest.deltas = [
    {
      from: "1.0.3",
      url: f.manifest.url.replace(f.name, deltaName),
      size: bytes.length,
      signature: sign(null, createHash("sha256").update(bytes).digest(), keys.privateKey).toString(
        "base64",
      ),
    },
  ];
  f.manifest.previous = [
    {
      version: "1.0.3",
      url: "https://example.test/old.tar.gz",
      size: 1,
      signature: f.manifest.signature,
    },
  ];
  await writeFile(f.manifestPath, JSON.stringify(f.manifest));
  assert.equal((await verifyArtifacts(f.c, f.root, ["darwin/arm64"])).length, 2);
  await writeFile(path.join(f.dir, deltaName), Buffer.alloc(bytes.length));
  await assert.rejects(verifyArtifacts(f.c, f.root, ["darwin/arm64"]), /签名/);
});

test("签 archive digest 而非原文；拒绝 symlink 和超大 manifest", async (t) => {
  const f = await fixture(t);
  f.manifest.signature = sign(
    null,
    Buffer.from("offline test archive bytes"),
    keys.privateKey,
  ).toString("base64");
  await writeFile(f.manifestPath, JSON.stringify(f.manifest));
  await assert.rejects(verifyArtifacts(f.c, f.root, ["darwin/arm64"]), /签名/);
  f.manifest.signature = sign(
    null,
    createHash("sha256").update("offline test archive bytes").digest(),
    keys.privateKey,
  ).toString("base64");
  await writeFile(f.manifestPath, JSON.stringify(f.manifest));
  await rm(path.join(f.dir, f.name));
  await writeFile(path.join(f.root, "outside"), "offline test archive bytes");
  await symlink(path.join(f.root, "outside"), path.join(f.dir, f.name));
  await assert.rejects(verifyArtifacts(f.c, f.root, ["darwin/arm64"]), /普通文件/);
  await writeFile(f.manifestPath, " ".repeat((1 << 20) + 1));
  await assert.rejects(verifyArtifacts(f.c, f.root, ["darwin/arm64"]), /1MiB/);
});

test("CLI 拒绝未知参数、冲突模式与缺平台值", async () => {
  for (const args of [
    ["--upload"],
    ["--build", "--check-only"],
    ["--platform"],
    ["--config", "mygo.json"],
    ["--platform", "darwin/arm64", "--platform", "linux/amd64"],
  ])
    await assert.rejects(main(args));
});

import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runRelease, SDK_VERSION, verifyArtifacts } from "./mygo-release.mjs";
import { vendorFixture } from "../vendor/fixture.mjs";

async function fixture(t) {
  const base = await mkdtemp(path.join(tmpdir(), "mygo-release-boundary-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, "project");
  const outside = path.join(base, "outside");
  await mkdir(root);
  await mkdir(outside);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const env = { MYGO_UPDATER_PRIVATE_KEY: Buffer.concat([seed, pub]).toString("base64") };
  const config = {
    slug: "app",
    version: "1.2.3",
    out: "build/mygo",
    updates: { publicKey: pub.toString("base64"), url: "https://example.test/updates" },
  };
  const bytes = Buffer.from("small offline fixture");
  const signature = sign(null, createHash("sha256").update(bytes).digest(), privateKey).toString(
    "base64",
  );
  const name = "app-1.2.3-darwin-arm64.tar.gz";
  const deltaName = "app-1.2.2-to-1.2.3-darwin-arm64.delta";
  const manifest = {
    version: config.version,
    url: `${config.updates.url}/${name}`,
    size: bytes.length,
    signature,
    deltas: [
      { from: "1.2.2", url: `${config.updates.url}/${deltaName}`, size: bytes.length, signature },
    ],
    previous: [
      { version: "1.2.2", url: "https://example.test/old.tar.gz", size: bytes.length, signature },
    ],
  };
  await writeFile(path.join(root, "mygo.json"), JSON.stringify(config));
  await writeFile(
    path.join(root, "go.mod"),
    `module fixture\nrequire (\n github.com/egoist/mygo ${SDK_VERSION}\n)\ntool github.com/egoist/mygo/cmd/mygo\n`,
  );
  await vendorFixture(root);
  const artifacts = (out) => {
    const dir = path.join(out, "darwin-arm64");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, name), bytes);
    writeFileSync(path.join(dir, deltaName), bytes);
    writeFileSync(path.join(dir, "update-darwin-arm64.json"), JSON.stringify(manifest));
  };
  return { root, outside, config, env, signature, manifest, artifacts };
}

for (const scenario of ["out", "ancestor", "missing-suffix"]) {
  for (const mode of ["verify-artifacts", "build"]) {
    test(`项目外 ${scenario} symlink：${mode} 在读取/spawn 前拒绝`, async (t) => {
      const f = await fixture(t);
      if (scenario === "out") {
        await mkdir(path.join(f.root, "build"));
        await symlink(f.outside, path.join(f.root, f.config.out));
        f.artifacts(f.outside);
      } else {
        await symlink(f.outside, path.join(f.root, "build"));
        if (scenario === "ancestor") f.artifacts(path.join(f.outside, "mygo"));
      }
      let calls = 0;
      await assert.rejects(
        runRelease({
          root: f.root,
          mode,
          env: f.env,
          spawn: () => {
            calls++;
            return { status: 2 };
          },
        }),
        /out.*项目/,
      );
      assert.equal(calls, 0);
    });
  }
}

test("输出目录尚未创建：校验不创建目录，合法路径可进入 fake build", async (t) => {
  const f = await fixture(t);
  const out = path.join(f.root, f.config.out);
  await runRelease({ root: f.root, mode: "check-only" });
  await assert.rejects(lstat(out), { code: "ENOENT" });
  let calls = 0;
  const result = await runRelease({
    root: f.root,
    mode: "build",
    env: f.env,
    spawn: () => {
      calls++;
      f.artifacts(out);
      return { status: 0 };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.artifacts.length, 2);
});

test("项目内 symlink 与 root 别名允许合法未创建后缀", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, "internal"));
  await symlink(path.join(f.root, "internal"), path.join(f.root, "build"));
  const alias = `${f.root}-alias`;
  await symlink(f.root, alias);
  await runRelease({
    root: alias,
    mode: "build",
    env: f.env,
    spawn: () => {
      f.artifacts(path.join(f.root, f.config.out));
      return { status: 0 };
    },
  });
});

for (const field of ["archive", "delta", "previous"]) {
  test(`${field} signature 拒绝首尾 space/tab`, async (t) => {
    const f = await fixture(t);
    const entry =
      field === "archive"
        ? f.manifest
        : field === "delta"
          ? f.manifest.deltas[0]
          : f.manifest.previous[0];
    for (const signature of [
      ` ${f.signature}`,
      `${f.signature} `,
      `\t${f.signature}`,
      `${f.signature}\t`,
    ]) {
      entry.signature = signature;
      f.artifacts(path.join(f.root, f.config.out));
      await assert.rejects(verifyArtifacts(f.config, f.root, ["darwin/arm64"]), /signature/);
    }
  });
}

test("archive/delta/previous signature 均接受 CRLF，密钥文本保留 trim", async (t) => {
  const f = await fixture(t);
  const signature = `\r\n${f.signature.slice(0, 20)}\r\n${f.signature.slice(20)}\r\n`;
  f.manifest.signature = signature;
  f.manifest.deltas[0].signature = signature;
  f.manifest.previous[0].signature = signature;
  f.config.updates.publicKey = ` \t${f.config.updates.publicKey}\n`;
  f.env.MYGO_UPDATER_PRIVATE_KEY = ` \t${f.env.MYGO_UPDATER_PRIVATE_KEY}\n`;
  await writeFile(path.join(f.root, "mygo.json"), JSON.stringify(f.config));
  f.artifacts(path.join(f.root, f.config.out));
  assert.equal((await verifyArtifacts(f.config, f.root, ["darwin/arm64"])).length, 2);
  await runRelease({ root: f.root, mode: "build", env: f.env, spawn: () => ({ status: 0 }) });
});

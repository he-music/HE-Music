import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyArtifacts } from "./mygo-release.mjs";

test("遵循 Go url.PathEscape：语义版本 build metadata 的加号不转义", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "mygo-release-protocol-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const config = {
    slug: "app",
    version: "1.2.3+build.1",
    out: "out",
    updates: {
      github: "owner/repo",
      tagPrefix: "desktop-v",
      publicKey: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64"),
    },
  };
  const dir = path.join(root, "out/darwin-arm64");
  await mkdir(dir, { recursive: true });
  const bytes = Buffer.from("fixture");
  const name = "app-1.2.3+build.1-darwin-arm64.tar.gz";
  await writeFile(path.join(dir, name), bytes);
  const manifest = {
    version: config.version,
    url: `https://github.com/owner/repo/releases/download/desktop-v1.2.3+build.1/${name}`,
    size: bytes.length,
    signature: sign(null, createHash("sha256").update(bytes).digest(), privateKey).toString(
      "base64",
    ),
  };
  await writeFile(path.join(dir, "update-darwin-arm64.json"), JSON.stringify(manifest));
  assert.equal((await verifyArtifacts(config, root, ["darwin/arm64"])).length, 1);
});

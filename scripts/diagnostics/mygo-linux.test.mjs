import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const flags = [
  "WEBKIT_SKIA_ENABLE_CPU_RENDERING",
  "WEBKIT_DISABLE_DMABUF_RENDERER",
  "WEBKIT_DISABLE_COMPOSITING_MODE",
  "LIBGL_ALWAYS_SOFTWARE",
];

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "he-music linux diagnostic "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = path.join(directory, "Start-Diagnostic.sh");
  await copyFile(new URL("./mygo-linux.sh", import.meta.url), script);
  const executable = path.join(directory, "he-music");
  await writeFile(
    executable,
    '#!/bin/sh\nprintf "child_flags=%s,%s,%s,%s\\n" "${WEBKIT_SKIA_ENABLE_CPU_RENDERING:-unset}" "${WEBKIT_DISABLE_DMABUF_RENDERER:-unset}" "${WEBKIT_DISABLE_COMPOSITING_MODE:-unset}" "${LIBGL_ALWAYS_SOFTWARE:-unset}"\n',
    { mode: 0o755 },
  );
  // 用固定命令替身检查包架构及插件分支，不扫描宿主 GStreamer。
  for (const [name, body] of Object.entries({
    dpkg: 'printf "amd64\\n"',
    "dpkg-query": 'printf "queried=%s\\n" "$3"',
    "gst-inspect-1.0": '[ "$1" != "webvttenc" ]',
    timeout: 'shift; exec "$@"',
  })) {
    await writeFile(path.join(directory, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }
  const env = { ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH}` };
  for (const flag of flags) delete env[flag];
  const run = (args = [], overrides = {}) =>
    spawnSync("sh", [script, ...args], {
      env: { ...env, ...overrides },
      encoding: "utf8",
      timeout: 10000,
    });
  return { directory, executable, run };
}

test("Software GL retains compositing before child launch and the log contains bounded dependency checks", async (t) => {
  const { directory, run } = await fixture(t);
  const result = run(["software-gl"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Mode: software-gl/);
  assert.match(result.stdout, /child_flags=1,0,0,1/);
  assert.match(result.stdout, /queried=libgtk-3-0:amd64/);
  assert.match(result.stdout, /GStreamer fakevideosink: available/);
  assert.match(result.stdout, /GStreamer webvttenc: unavailable or check timed out/);
  assert.equal(
    await readFile(path.join(directory, "ubuntu22-software-gl-diagnostic.log"), "utf8"),
    result.stdout,
  );
});

test("normal diagnostic clears compatibility flags and accepts a program path with spaces", async (t) => {
  const { directory, executable, run } = await fixture(t);
  const renamed = path.join(directory, "player with spaces");
  await copyFile(executable, renamed);
  const result = run(["normal", renamed], { WEBKIT_SKIA_ENABLE_CPU_RENDERING: "0" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Mode: normal/);
  assert.match(result.stdout, /child_flags=unset,unset,unset,unset/);
});

test("default mode does not force process-wide CPU rendering", async (t) => {
  const { run } = await fixture(t);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Mode: normal/);
  assert.match(result.stdout, /child_flags=unset,unset,unset,unset/);
});

test("unknown modes and missing programs do not start an application", async (t) => {
  const { directory, run } = await fixture(t);
  for (const args of [["unknown"], ["software-gl", path.join(directory, "missing")]]) {
    const result = run(args);
    assert.equal(result.status, 2);
    assert.doesNotMatch(result.stdout, /child_flags=/);
  }
});

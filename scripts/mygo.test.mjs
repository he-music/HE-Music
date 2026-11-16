import assert from "node:assert/strict";
import test from "node:test";
import { runMygo } from "./mygo.mjs";

for (const command of ["build", "dev"]) {
  test(`${command} 先准备 libmpv 再调用官方 Go 工具，保留自定义编译标签`, () => {
    const calls = [];
    const args = [command, "-platform", "windows/arm64"];
    const env = { GOFLAGS: "-tags=nativeprobe", GOWORK: "external.work" };
    const result = runMygo(args, {
      root: "/project with spaces",
      env,
      prepare: (root, actual, environment) => {
        calls.push("resources");
        assert.equal(root, "/project with spaces");
        assert.deepEqual(actual, args);
        assert.equal(environment, env);
      },
      spawn: (executable, actual, options) => {
        calls.push("go");
        assert.equal(executable, "go");
        assert.deepEqual(actual, ["tool", "mygo", ...args]);
        assert.equal(options.cwd, "/project with spaces");
        assert.equal(options.env.GOWORK, "off");
        assert.equal(options.env.GOFLAGS, "-tags=nativeprobe -mod=readonly");
        assert.equal(options.shell, false);
        return { status: 0 };
      },
    });
    assert.equal(result, 0);
    assert.deepEqual(calls, ["resources", "go"]);
  });
}

test("生成绑定不准备资源，并透传官方工具的失败状态", () => {
  assert.equal(
    runMygo(["generate"], {
      prepare: () => assert.fail("生成绑定不应准备 libmpv"),
      spawn: () => ({ status: 2 }),
    }),
    2,
  );
});

test("资源失败时不运行 Go，也不接受已移除的 vendor 子命令", () => {
  const spawn = () => assert.fail("不应运行 Go");
  assert.throws(
    () =>
      runMygo(["build"], {
        prepare: () => {
          throw new Error("resource failure");
        },
        spawn,
      }),
    /resource failure/,
  );
  assert.throws(() => runMygo(["refresh"], { spawn }), /用法/);
});

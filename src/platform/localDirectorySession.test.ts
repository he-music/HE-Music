import { afterEach, describe, expect, it, vi } from "vitest";
import { effectScope, nextTick, shallowRef, type Ref } from "vue";
import type { PlatformFiles } from "./files";
import type { DirectorySelection } from "./mygo.bindings";
import { FilesSession, filesSession } from "./filesSession";
import { createLocalDirectorySession } from "./localDirectorySession";

const grant = { token: "synthetic-token", displayPath: "/synthetic/music", epoch: 1 };
function selected(): DirectorySelection {
  return { status: "selected", grant, relation: "", existingToken: "" };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function provider(): PlatformFiles {
  return {
    begin: vi.fn(async () => ({ epoch: 1 })),
    chooseDirectory: vi.fn(async () => selected()),
    defaultDirectory: vi.fn(async () => ({
      kind: "music" as const,
      displayPath: "/synthetic/default",
      authorized: false,
    })),
    revokeDirectory: vi.fn(async () => {}),
    importSettings: vi.fn(async () => ({ status: "cancelled" as const, document: null })),
    exportSettings: vi.fn(async () => ({ status: "saved" as const })),
    teardown: vi.fn(async () => {}),
  };
}
const scopes: ReturnType<typeof effectScope>[] = [];
function controller(current: Readonly<Ref<FilesSession | undefined>> = filesSession) {
  const scope = effectScope();
  scopes.push(scope);
  const state = scope.run(() => createLocalDirectorySession(current))!;
  return { state, close: () => scope.stop() };
}
afterEach(async () => {
  scopes.splice(0).forEach((scope) => scope.stop());
  await filesSession.value?.dispose();
});

describe("目录授权会话", () => {
  it("未开始和无provider不调用选择；默认和持久路径不建立grant", async () => {
    const native = provider();
    const session = new FilesSession(native);
    expect(await session.chooseDirectory()).toEqual({ status: "unavailable" });
    expect(native.chooseDirectory).not.toHaveBeenCalled();
    const absent = controller(shallowRef<FilesSession>());
    await absent.state.choose();
    expect(absent.state.feedback.value).toBe("unavailable");
    await session.start();
    const { state } = controller();
    await state.showDefault();
    expect(state.suggestion.value).toBe("/synthetic/default");
    expect(state.grants.value).toEqual([]);
    expect(native.defaultDirectory).toHaveBeenCalledWith(1, "music");
  });

  it("selected加入，cancel不改变，重复token稳定，撤销成功后可重新选择", async () => {
    const native = provider();
    const session = new FilesSession(native);
    await session.start();
    const { state } = controller();
    await state.choose();
    expect(state.grants.value).toEqual([grant]);
    await state.choose();
    expect(state.grants.value).toHaveLength(1);
    vi.mocked(native.chooseDirectory).mockResolvedValueOnce({
      status: "cancelled",
      grant: null,
      relation: "",
      existingToken: "",
    });
    await state.choose();
    expect(state.feedback.value).toBe("cancelled");
    expect(state.grants.value).toEqual([grant]);
    await state.revoke(grant.token);
    expect(native.revokeDirectory).toHaveBeenCalledWith(1, grant.token);
    expect(state.grants.value).toEqual([]);
    await state.choose();
    expect(state.grants.value).toEqual([grant]);
  });

  it.each(["duplicate", "child", "parent"] as const)(
    "overlap %s明确反馈不插入",
    async (relation) => {
      const native = provider();
      const session = new FilesSession(native);
      await session.start();
      const { state } = controller();
      await state.choose();
      vi.mocked(native.chooseDirectory).mockResolvedValueOnce({
        status: "overlap",
        grant: null,
        relation,
        existingToken: grant.token,
      });
      await state.choose();
      expect(state.feedback.value).toBe(relation);
      expect(state.grants.value).toEqual([grant]);
    },
  );

  it("目录picker与设置JSON共享busy，失败保持grant并可重试", async () => {
    const native = provider();
    const session = new FilesSession(native);
    await session.start();
    const panel = deferred<DirectorySelection>();
    vi.mocked(native.chooseDirectory).mockReturnValueOnce(panel.promise);
    const pending = session.chooseDirectory();
    expect(await session.importSettings()).toEqual({ status: "busy" });
    expect(await session.defaultDirectory("music")).toEqual({ status: "busy" });
    expect(await session.revokeDirectory(grant.token)).toEqual({ status: "busy" });
    panel.resolve(selected());
    await pending;
    const { state } = controller();
    vi.mocked(native.revokeDirectory).mockRejectedValueOnce(new Error("synthetic failure"));
    await state.revoke(grant.token);
    expect(state.feedback.value).toBe("failed");
    expect(state.grants.value).toEqual([grant]);
    expect(session.busy.value).toBe(false);
    vi.mocked(native.chooseDirectory).mockRejectedValueOnce(new Error("grant limit"));
    await state.choose();
    expect(state.feedback.value).toBe("failed");
    expect(state.grants.value).toEqual([grant]);
    expect(await session.exportSettings({ "setting-store": "{}", "shortcut-store": "{}" })).toEqual(
      {
        status: "completed",
        value: { status: "saved" },
      },
    );
    expect(await session.importSettings()).toEqual({
      status: "completed",
      value: { status: "cancelled", document: null },
    });
  });

  it("dispose清授权；旧picker迟到不能写新会话；新会话需重新选择", async () => {
    const native = provider();
    const old = new FilesSession(native);
    await old.start();
    await old.chooseDirectory();
    const { state } = controller();
    const panel = deferred<DirectorySelection>();
    vi.mocked(native.chooseDirectory).mockReturnValueOnce(panel.promise);
    const pending = state.choose();
    await old.dispose();
    expect(old.directories.value).toEqual([]);
    const next = new FilesSession(provider());
    await next.start();
    await nextTick();
    panel.resolve(selected());
    await pending;
    expect(state.grants.value).toEqual([]);
    expect(state.feedback.value).toBe("");
    await state.choose();
    expect(state.grants.value).toEqual([grant]);
  });

  it("关闭modal仅停止反馈；授权在全局会话保留，重开复用且不Begin", async () => {
    const native = provider();
    const session = new FilesSession(native);
    await session.start();
    const first = controller();
    const panel = deferred<DirectorySelection>();
    vi.mocked(native.chooseDirectory).mockReturnValueOnce(panel.promise);
    const pending = first.state.choose();
    first.close();
    panel.resolve(selected());
    await pending;
    expect(first.state.feedback.value).toBe("");
    const next = controller();
    expect(next.state.grants.value).toEqual([grant]);
    expect(native.begin).toHaveBeenCalledOnce();
    expect(native.teardown).not.toHaveBeenCalled();
  });
});

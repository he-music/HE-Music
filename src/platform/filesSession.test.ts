import { afterEach, describe, expect, it, vi } from "vitest";
import { createFilesSession, filesSession, FilesSession } from "./filesSession";
import type { PlatformFiles } from "./files";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function provider(): PlatformFiles {
  return {
    begin: vi.fn(async () => ({ epoch: 1 })),
    chooseDirectory: vi.fn(),
    defaultDirectory: vi.fn(),
    revokeDirectory: vi.fn(),
    importSettings: vi.fn<PlatformFiles["importSettings"]>(async () => ({
      status: "cancelled",
      document: null,
    })),
    exportSettings: vi.fn<PlatformFiles["exportSettings"]>(async () => ({ status: "cancelled" })),
    teardown: vi.fn(async () => {}),
  };
}
afterEach(async () => {
  await filesSession.value?.dispose();
  vi.restoreAllMocks();
});

describe("FilesSession", () => {
  it("has no session without an optional provider", () => {
    expect(createFilesSession()).toBeUndefined();
  });
  it("waits for late begin cleanup before the next shell Ready on the same Page context", async () => {
    const native = provider();
    const gate = deferred<void>();
    let nativeEpoch = 0;
    let nextEpoch = 0;
    native.begin = vi.fn(async () => {
      await gate.promise;
      // Model Go begin(ctx): repeated begin on the same live owner returns its epoch.
      nativeEpoch ||= ++nextEpoch;
      return { epoch: nativeEpoch };
    });
    native.teardown = vi.fn(async (epoch) => {
      if (epoch === nativeEpoch) nativeEpoch = 0;
    });
    const old = new FilesSession(native);
    const beginning = old.start();
    const closing = old.dispose();
    expect(old.dispose()).toBe(closing);
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    const replacement = new FilesSession(native);
    const transition = closing.then(() => replacement.start());
    gate.resolve();
    await beginning;
    await transition;
    expect(filesSession.value).toBe(replacement);
    expect(nativeEpoch).toBe(2);
    expect(native.teardown).toHaveBeenCalledExactlyOnceWith(1);
  });
  it("invalidates immediately and tears down without waiting for a picker", async () => {
    const native = provider();
    const panel = deferred<Awaited<ReturnType<PlatformFiles["importSettings"]>>>();
    native.importSettings = vi.fn(() => panel.promise);
    const session = new FilesSession(native);
    expect(await session.importSettings()).toEqual({ status: "unavailable" });
    expect(native.importSettings).not.toHaveBeenCalled();
    await session.start();
    const operation = session.importSettings();
    expect(await session.importSettings()).toEqual({ status: "busy" });
    const cleanup = session.dispose();
    expect(session.ready.value).toBe(false);
    expect(filesSession.value).toBeUndefined();
    expect(native.teardown).toHaveBeenCalledWith(1);
    await cleanup;
    panel.resolve({ status: "selected", document: null });
    expect(await operation).toEqual({ status: "stale" });
  });
  it("keeps a replacement registry when the old operation completes", async () => {
    const native = provider();
    const panel = deferred<Awaited<ReturnType<PlatformFiles["exportSettings"]>>>();
    native.exportSettings = vi.fn(() => panel.promise);
    const old = new FilesSession(native);
    await old.start();
    const operation = old.exportSettings({ "setting-store": "{}", "shortcut-store": "{}" });
    await old.dispose();
    const next = new FilesSession(provider());
    await next.start();
    panel.resolve({ status: "saved" });
    expect(await operation).toEqual({ status: "stale" });
    await old.dispose();
    expect(filesSession.value).toBe(next);
    expect(native.teardown).toHaveBeenCalledTimes(1);
  });
  it("contains begin and operation errors without logging host error objects", async () => {
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    const native = provider();
    vi.mocked(native.begin).mockRejectedValueOnce(new Error("private host detail"));
    const session = new FilesSession(native);
    await session.start();
    expect(session.ready.value).toBe(false);
    expect(report).toHaveBeenCalledExactlyOnceWith("文件会话初始化失败");
    const next = new FilesSession(native);
    await next.start();
    vi.mocked(native.importSettings).mockRejectedValueOnce(new Error("private picker detail"));
    expect(await next.importSettings()).toEqual({ status: "failed" });
    expect(next.busy.value).toBe(false);
    expect(await next.importSettings()).toEqual({
      status: "completed",
      value: { status: "cancelled", document: null },
    });
  });
});

import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dispose: vi.fn(async () => {}),
  flush: vi.fn(async () => {}),
  error: vi.fn(),
}));
vi.mock("./filesSession", async () => {
  const { ref } = await import("vue");
  return {
    filesSession: ref({ capturePreferencesResetOwner: () => ({ dispose: mocks.dispose }) }),
  };
});
vi.mock("./applicationStorage", () => ({ flushApplicationWrites: mocks.flush }));
import { installApplicationQuitHandler } from "./applicationQuit";

const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal("window", { $message: { error: mocks.error } });
  mocks.dispose.mockReset();
  mocks.flush.mockReset();
  mocks.error.mockReset();
});
afterEach(() => {
  cleanups.splice(0).forEach((off) => off());
  vi.unstubAllGlobals();
});
function install() {
  const off = installApplicationQuitHandler(() => mocks.error("message.save_before_quit_failed"));
  cleanups.push(off);
  const prepare = window.__heMusicPrepareQuit;
  if (!prepare) throw new Error("Missing quit save handler");
  return { off, prepare };
}

it("waits for file teardown and durable writes before permitting a native restart", async () => {
  const calls: string[] = [];
  let finish!: () => void;
  mocks.dispose.mockImplementationOnce(async () => {
    calls.push("files");
  });
  mocks.flush.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        calls.push("flush");
        finish = resolve;
      }),
  );
  const { prepare } = install();
  const result = prepare();
  expect(prepare()).toBe(result);
  await Promise.resolve();
  expect(calls).toEqual(["flush"]);
  expect(mocks.dispose).not.toHaveBeenCalled();
  let completed = false;
  void result.then(() => {
    completed = true;
  });
  await Promise.resolve();
  expect(completed).toBe(false);
  finish();
  expect(await result).toBe(true);
  expect(calls).toEqual(["flush", "files"]);
  expect(mocks.flush).toHaveBeenCalledTimes(2);
});

it("rejects a quit when saving fails and allows a later retry", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.flush.mockRejectedValueOnce(new Error("disk full"));
  const { prepare } = install();
  expect(await prepare()).toBe(false);
  expect(mocks.dispose).not.toHaveBeenCalled();
  expect(mocks.error).toHaveBeenCalledWith("message.save_before_quit_failed");
  expect(await prepare()).toBe(true);
  vi.restoreAllMocks();
});

it("a disposed handler cannot authorize quit or remove its replacement", async () => {
  const old = install();
  const next = install();
  old.off();
  expect(window.__heMusicPrepareQuit).toBe(next.prepare);
  expect(await old.prepare()).toBe(false);
  expect(await next.prepare()).toBe(true);
  next.off();
  expect(window.__heMusicPrepareQuit).toBeUndefined();
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LibrarySync } from "./librarySync";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function fixture() {
  const windowEvents = new EventTarget();
  const documentEvents = new EventTarget();
  const state = { visible: true, idle: true };
  const refresh = vi.fn<(signal: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);
  const report = vi.fn();
  const sync = new LibrarySync({
    windowEvents,
    documentEvents,
    refresh,
    report,
    visible: () => state.visible,
    canRefresh: () => state.idle,
  });
  sync.start();
  return { sync, windowEvents, documentEvents, state, refresh, report };
}

describe("曲库自动同步调度", () => {
  it("页面可见时每分钟检查一次，频繁聚焦不会重复扫描", async () => {
    const f = fixture();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.refresh).toHaveBeenCalledOnce();
    f.windowEvents.dispatchEvent(new Event("focus"));
    f.windowEvents.dispatchEvent(new Event("focus"));
    expect(f.refresh).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5000);
    f.windowEvents.dispatchEvent(new Event("focus"));
    expect(f.refresh).toHaveBeenCalledTimes(2);
    f.sync.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("页面隐藏停止定时器，恢复可见后检查变化", async () => {
    const f = fixture();
    f.state.visible = false;
    f.documentEvents.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.refresh).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    f.state.visible = true;
    f.documentEvents.dispatchEvent(new Event("visibilitychange"));
    expect(f.refresh).toHaveBeenCalledOnce();
    f.sync.stop();
  });

  it("手动扫描、写入或下载占用期间不启动自动检查", async () => {
    const f = fixture();
    f.state.idle = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.refresh).not.toHaveBeenCalled();
    f.state.idle = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.refresh).toHaveBeenCalledOnce();
    f.sync.stop();
  });

  it("卸载取消自有扫描并移除事件，不再后台启动", async () => {
    const f = fixture();
    let signal: AbortSignal | undefined;
    f.refresh.mockImplementationOnce((value) => {
      signal = value;
      return new Promise((resolve) => value.addEventListener("abort", () => resolve()));
    });
    const pending = f.sync.request(true);
    await f.sync.request(true);
    expect(f.refresh).toHaveBeenCalledOnce();
    f.sync.stop();
    expect(signal?.aborted).toBe(true);
    await pending;
    f.windowEvents.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.refresh).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("失败后仍可继续同步，不留下重复定时器", async () => {
    const f = fixture();
    f.refresh.mockRejectedValueOnce(new Error("unavailable"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.report).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.refresh).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    f.sync.stop();
  });
});

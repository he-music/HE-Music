import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { finishStartupLoading, removeStartupLoading } from "./startupLoading";

const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const roleScript = html.match(/<script id="startup-window-role">([\s\S]*?)<\/script>/)?.[1];

afterEach(() => vi.unstubAllGlobals());

describe("启动加载界面", () => {
  it("保留覆盖层跨过首屏绘制，再同时移除界面和临时样式", async () => {
    const loading = { remove: vi.fn() };
    const style = { remove: vi.fn() };
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("document", {
      getElementById: (id: string) => (id === "startup-loading" ? loading : style),
    });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      frames.push(callback),
    );

    const finished = finishStartupLoading();
    expect(loading.remove).not.toHaveBeenCalled();
    frames.shift()?.(0);
    expect(loading.remove).not.toHaveBeenCalled();
    frames.shift()?.(16);
    await finished;
    expect(loading.remove).toHaveBeenCalledOnce();
    expect(style.remove).toHaveBeenCalledOnce();
  });

  it("加载层已被失败入口或歌词入口清理时仍可完成", async () => {
    vi.stubGlobal("document", { getElementById: () => null });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    expect(removeStartupLoading).not.toThrow();
    await expect(finishStartupLoading()).resolves.toBeUndefined();
  });
});

describe("HTML 首次解析时识别桌面子窗口", () => {
  it.each([
    [true, "#/desktop-lyric", "desktop-lyrics-window"],
    [true, "#/desktop-lyric?source=window", "desktop-lyrics-window"],
    [true, "#/mini-player#section", "mini-player-window"],
    [true, "#/desktop-lyric-extra", null],
    [true, "#/mini-player-extra", null],
    [true, "#/search?keyword=desktop-lyric", null],
    [true, "#", null],
    [false, "#/desktop-lyric", null],
    [false, "#/mini-player", null],
  ])("native=%s hash=%s，首次解析的角色正确", (native, hash, role) => {
    const add = vi.fn();
    expect(roleScript).toBeTruthy();
    runInNewContext(roleScript ?? "", {
      window: { mygo: native ? {} : undefined },
      location: { hash },
      document: { documentElement: { classList: { add } } },
    });
    if (role) expect(add).toHaveBeenCalledWith(role);
    else expect(add).not.toHaveBeenCalled();
  });
});

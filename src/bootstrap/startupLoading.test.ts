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

describe("HTML 首次解析时识别歌词窗口", () => {
  it.each([
    [true, "#/desktop-lyric", true],
    [true, "#/desktop-lyric?source=window", true],
    [true, "#/desktop-lyric#section", true],
    [true, "#/desktop-lyric-extra", false],
    [true, "#/search?keyword=desktop-lyric", false],
    [true, "#", false],
    [false, "#/desktop-lyric", false],
  ])("native=%s hash=%s，首次解析的角色正确", (native, hash, lyrics) => {
    const add = vi.fn();
    expect(roleScript).toBeTruthy();
    runInNewContext(roleScript ?? "", {
      window: { mygo: native ? {} : undefined },
      location: { hash },
      document: { documentElement: { classList: { add } } },
    });
    if (lyrics) expect(add).toHaveBeenCalledWith("desktop-lyrics-window");
    else expect(add).not.toHaveBeenCalled();
  });
});

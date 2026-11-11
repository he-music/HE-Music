import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrapWindow } from "./window";
import { isDesktopLyricsWindow } from "./windowRole";

const mounts = vi.hoisted(() => ({ main: vi.fn(), lyrics: vi.fn() }));
vi.mock("./mainWindow", () => ({ mountMainWindow: mounts.main }));
vi.mock("./lyricsWindow", () => ({ mountLyricsWindow: mounts.lyrics }));
afterEach(() => vi.resetAllMocks());

describe("窗口启动角色", () => {
  it.each(["mygo"] as const)("%s 歌词窗口只加载子页入口", async (kind) => {
    await bootstrapWindow(kind, "#/desktop-lyric");
    expect(mounts.lyrics).toHaveBeenCalledOnce();
    expect(mounts.main).not.toHaveBeenCalled();
  });

  it.each(["#/desktop-lyric?source=window", "#/desktop-lyric#section"])(
    "只解析精确路由路径：%s",
    (hash) => {
      expect(isDesktopLyricsWindow("mygo", hash)).toBe(true);
    },
  );

  it.each([
    "",
    "#/",
    "#/desktop-lyric-extra",
    "#/search?keyword=desktop-lyric",
    "#/playlist/desktop-lyric",
    "desktop-lyric",
  ])("相似地址仍使用主窗口入口：%s", async (hash) => {
    await bootstrapWindow("mygo", hash);
    expect(mounts.main).toHaveBeenCalledOnce();
    expect(mounts.lyrics).not.toHaveBeenCalled();
  });

  it("Web 不因桌面歌词路径获得原生子页身份", async () => {
    await bootstrapWindow("web", "#/desktop-lyric");
    expect(mounts.main).toHaveBeenCalledOnce();
    expect(mounts.lyrics).not.toHaveBeenCalled();
  });

  it("主窗口等待首屏就绪后才完成启动", async () => {
    let resolveReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    mounts.main.mockReturnValueOnce(ready);
    const completed = vi.fn();
    const startup = bootstrapWindow("mygo", "#/").then(completed);
    await vi.waitFor(() => expect(mounts.main).toHaveBeenCalledOnce());
    expect(completed).not.toHaveBeenCalled();
    resolveReady?.();
    await startup;
    expect(completed).toHaveBeenCalledOnce();
  });

  it("异步首屏初始化失败继续交给启动失败入口处理", async () => {
    mounts.main.mockRejectedValueOnce(new Error("route unavailable"));
    await expect(bootstrapWindow("mygo", "#/")).rejects.toThrow("route unavailable");
    expect(mounts.lyrics).not.toHaveBeenCalled();
  });

  it("子页挂载失败不会退回主播放器初始化", async () => {
    mounts.lyrics.mockImplementationOnce(() => {
      throw new Error("synthetic child mount failure");
    });
    await expect(bootstrapWindow("mygo", "#/desktop-lyric")).rejects.toThrow(
      "synthetic child mount failure",
    );
    expect(mounts.main).not.toHaveBeenCalled();
  });
});

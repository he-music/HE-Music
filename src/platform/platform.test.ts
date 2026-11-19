import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebPlatform } from "./web";
import { createMygoPlatform } from "./mygo";
import { externalHttpURL, systemFromUserAgent } from "./types";

const bridge = vi.hoisted(() => ({
  platform: "darwin",
  off: vi.fn(),
  on: vi.fn(),
  call: vi.fn().mockResolvedValue(undefined),
  minimize: vi.fn().mockResolvedValue(undefined),
  toggleMaximize: vi.fn().mockResolvedValue(undefined),
  isMaximized: vi.fn().mockResolvedValue(false),
  toggleFullScreen: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("mygo-runtime", () => ({
  runtime: () => ({ platform: bridge.platform }),
  currentWindow: bridge,
  call: (...args: unknown[]) => bridge.call(...args),
  event: () => ({ on: (listener: (value: boolean) => void) => bridge.on(listener) }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("platform adapters", () => {
  it("mygo 暴露桌面歌词全局快捷键并保留注册输入和原生事件", async () => {
    const shortcuts = createMygoPlatform().shortcuts;
    if (!shortcuts) throw new Error("No shortcuts");
    expect(shortcuts.actions).toContain("toggleDesktopLyric");
    const bindings = [{ action: "toggleDesktopLyric" as const, accelerator: "CmdOrCtrl+Shift+D" }];
    bridge.call.mockResolvedValueOnce({
      generation: 7,
      enabled: true,
      suspended: false,
      results: [],
    });
    await shortcuts.replace(6, true, bindings);
    expect(bridge.call).toHaveBeenLastCalledWith("GlobalShortcuts.Replace", 6, true, bindings);
    const off = vi.fn();
    bridge.on.mockReturnValueOnce(off);
    const listener = vi.fn();
    const stop = shortcuts.onAction(listener);
    const emit = bridge.on.mock.calls.at(-1)?.[0];
    if (typeof emit !== "function") throw new Error("No shortcut listener");
    emit({ generation: 7, action: "toggleDesktopLyric" });
    expect(listener).toHaveBeenCalledExactlyOnceWith({
      generation: 7,
      action: "toggleDesktopLyric",
    });
    stop();
    expect(off).toHaveBeenCalledOnce();
  });
  it("Web 不启用桌面能力，外链使用隔离窗口", async () => {
    const open = vi.fn();
    vi.stubGlobal("window", { open });
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Windows NT 10.0)" });
    const web = createWebPlatform();
    expect(web.kind).toBe("web");
    expect(web.os).toBe("win32");
    expect(Object.values(web.capabilities)).not.toContain(true);
    expect(web.window).toBeNull();
    await web.openExternal("https://example.com");
    expect(open).toHaveBeenCalledWith("https://example.com/", "_blank", "noopener,noreferrer");
    await expect(web.openExternal("javascript:alert(1)")).rejects.toThrow();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("Safari 通过 WebKit 接口进入和退出全屏，并从系统事件获取状态", async () => {
    const root = { webkitRequestFullscreen: vi.fn() };
    const doc = Object.assign(new EventTarget(), {
      documentElement: root,
      webkitExitFullscreen: vi.fn(),
      webkitFullscreenElement: null as typeof root | null,
    });
    vi.stubGlobal("document", doc);
    const fullscreen = createWebPlatform().fullscreen;
    if (!fullscreen) throw new Error("No Safari fullscreen");

    const listener = vi.fn();
    const off = fullscreen.onChange(listener);
    expect(fullscreen.current()).toBe(false);
    const entering = fullscreen.toggle();
    expect(root.webkitRequestFullscreen).toHaveBeenCalledOnce();
    await entering;
    doc.webkitFullscreenElement = root;
    doc.dispatchEvent(new Event("webkitfullscreenchange"));
    expect(listener).toHaveBeenLastCalledWith(true);
    await fullscreen.toggle();
    expect(doc.webkitExitFullscreen).toHaveBeenCalledOnce();
    doc.webkitFullscreenElement = null;
    doc.dispatchEvent(new Event("webkitfullscreenchange"));
    expect(listener).toHaveBeenLastCalledWith(false);
    off();
    doc.dispatchEvent(new Event("webkitfullscreenchange"));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("标准全屏不依赖旧版浏览器的状态属性，且尊重浏览器的全屏权限", async () => {
    const root = { requestFullscreen: vi.fn() };
    const doc = Object.assign(new EventTarget(), {
      documentElement: root,
      fullscreenEnabled: false,
      fullscreenElement: null,
      exitFullscreen: vi.fn(),
    });
    vi.stubGlobal("document", doc);
    expect(createWebPlatform().fullscreen).toBeNull();
    doc.fullscreenEnabled = true;
    await createWebPlatform().fullscreen?.toggle();
    expect(root.requestFullscreen).toHaveBeenCalledOnce();
  });

  it("mygo 系统来自原生运行时，窗口控制不访问 Electron，事件可退订", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { userAgent: "Linux" });
    bridge.on.mockReturnValue(bridge.off);
    const mygo = createMygoPlatform();
    expect(mygo.os).toBe("darwin");
    expect(mygo.capabilities.windowControls).toBe(true);
    expect(mygo.capabilities.tray).toBe(false);
    expect(mygo.capabilities.desktopLyrics).toBe(false);
    expect(mygo.capabilities.localMusic).toBe(false);
    await mygo.window?.minimize();
    await mygo.window?.toggleMaximize();
    expect(await mygo.window?.isMaximized()).toBe(false);
    await mygo.fullscreen?.toggle();
    expect(bridge.toggleFullScreen).toHaveBeenCalledOnce();
    bridge.call.mockResolvedValueOnce(true);
    expect(await mygo.fullscreen?.current()).toBe(true);
    expect(bridge.call).toHaveBeenCalledWith("DesktopPlatform.IsFullScreen");
    bridge.call.mockClear();
    const fullscreenListener = vi.fn();
    const stopFullscreen = mygo.fullscreen?.onChange(fullscreenListener);
    expect(bridge.on).toHaveBeenLastCalledWith(fullscreenListener);
    stopFullscreen?.();
    expect(bridge.off).toHaveBeenCalledOnce();
    bridge.off.mockClear();
    const listener = vi.fn();
    const off = mygo.window?.onMaximized(listener);
    expect(bridge.on).toHaveBeenCalledWith(listener);
    off?.();
    expect(bridge.off).toHaveBeenCalledOnce();
    await mygo.window?.close();
    expect(bridge.close).toHaveBeenCalledOnce();
    await mygo.openExternal("https://example.com/path");
    expect(bridge.call).toHaveBeenCalledWith(
      "DesktopPlatform.OpenExternal",
      "https://example.com/path",
    );
    await expect(mygo.openExternal("file:///tmp/test")).rejects.toThrow();
    expect(bridge.call).toHaveBeenCalledOnce();
  });

  it("识别系统并拒绝非 HTTP(S) 外链", () => {
    expect(systemFromUserAgent("Macintosh")).toBe("darwin");
    expect(systemFromUserAgent("Linux x86_64")).toBe("linux");
    expect(systemFromUserAgent("other")).toBe("unknown");
    for (const url of ["file:///etc/hosts", "mygo://localhost", "data:text/html,test"]) {
      expect(() => externalHttpURL(url)).toThrow();
    }
  });
});

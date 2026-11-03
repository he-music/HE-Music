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

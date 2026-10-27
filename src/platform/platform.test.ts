import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebPlatform } from "./web";
import { createElectronPlatform } from "./electron";
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
    expect(mygo.capabilities.electronStartup).toBe(false);
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

  it("Electron 保留原 IPC，并只移除自己的窗口监听", async () => {
    const off = vi.fn();
    const ipc = { send: vi.fn(), sendSync: vi.fn(), on: vi.fn().mockReturnValue(off) };
    vi.stubGlobal("window", { electron: { ipcRenderer: ipc } });
    vi.stubGlobal("navigator", { userAgent: "Macintosh Electron" });
    const electron = createElectronPlatform();
    expect(electron.capabilities.electronStartup).toBe(true);
    ipc.sendSync.mockReturnValue(true);
    await electron.window?.toggleMaximize();
    expect(ipc.send).toHaveBeenCalledWith("win-restore");
    ipc.sendSync.mockReturnValue(false);
    await electron.window?.toggleMaximize();
    expect(ipc.send).toHaveBeenCalledWith("win-max");
    const listener = vi.fn();
    const unsubscribe = electron.window?.onMaximized(listener);
    ipc.on.mock.calls[0][1]({}, true);
    expect(listener).toHaveBeenCalledWith(true);
    unsubscribe?.();
    expect(off).toHaveBeenCalledOnce();
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

import { afterEach, describe, expect, it, vi } from "vitest";

// 使用真实 mygo-runtime，覆盖普通浏览器导入生成客户端的路径。
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("platform host selection", () => {
  it("普通 Web 可安全导入生成事件，不要求 mygo 或 Electron", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Macintosh)" });
    vi.stubGlobal("mygo", undefined);
    const { platform, isElectronHost } = await import("./index");
    expect(platform.kind).toBe("web");
    expect(platform.os).toBe("darwin");
    expect(isElectronHost).toBe(false);
  });

  it("mygo 不冒充 Electron，使用原生平台而非 WebView UA", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Macintosh)" });
    vi.stubGlobal("mygo", { platform: "win32" });
    const { platform, isElectronHost } = await import("./index");
    expect(platform.kind).toBe("mygo");
    expect(platform.os).toBe("win32");
    expect(isElectronHost).toBe(false);
    expect(platform.capabilities.electronStartup).toBe(false);
  });
  it("mygo 优先选择且不读取 Electron 或旧 store 全局", async () => {
    const forbiddenRead = vi.fn(() => {
      throw new Error("unexpected Electron global read");
    });
    const childWindow = {};
    Object.defineProperties(childWindow, {
      electron: { get: forbiddenRead },
      api: { get: forbiddenRead },
    });
    vi.stubGlobal("window", childWindow);
    vi.stubGlobal("navigator", { userAgent: "Macintosh Electron" });
    vi.stubGlobal("mygo", { platform: "darwin" });
    const { platform, isElectronHost } = await import("./index");
    expect(platform.kind).toBe("mygo");
    expect(isElectronHost).toBe(false);
    expect(forbiddenRead).not.toHaveBeenCalled();
  });
});

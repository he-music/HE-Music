import { afterEach, describe, expect, it, vi } from "vitest";

// Use the real runtime to cover safe browser imports of generated clients.
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("platform host selection", () => {
  it("普通 Web 可安全导入生成客户端", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Macintosh)" });
    vi.stubGlobal("mygo", undefined);
    const { platform } = await import("./index");
    expect(platform.kind).toBe("web");
    expect(platform.os).toBe("darwin");
  });

  it("mygo 使用原生平台而非 WebView UA", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Macintosh)" });
    vi.stubGlobal("mygo", { platform: "win32" });
    const { platform } = await import("./index");
    expect(platform.kind).toBe("mygo");
    expect(platform.os).toBe("win32");
  });

  it.each([false, true])("选择宿主不读取旧 Electron 全局（mygo=%s）", async (native) => {
    const forbiddenRead = vi.fn(() => {
      throw new Error("unexpected legacy bridge read");
    });
    const childWindow = {};
    Object.defineProperties(childWindow, {
      electron: { get: forbiddenRead },
      api: { get: forbiddenRead },
    });
    vi.stubGlobal("window", childWindow);
    vi.stubGlobal("navigator", { userAgent: "Macintosh Electron" });
    vi.stubGlobal("mygo", native ? { platform: "darwin" } : undefined);
    const { platform } = await import("./index");
    expect(platform.kind).toBe(native ? "mygo" : "web");
    expect(forbiddenRead).not.toHaveBeenCalled();
  });
});

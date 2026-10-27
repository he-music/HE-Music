import { afterEach, describe, expect, it, vi } from "vitest";
import { createMygoPlatform } from "./mygo";
const bridge = vi.hoisted(() => ({ call: vi.fn(), on: vi.fn() }));
vi.mock("mygo-runtime", () => ({
  runtime: () => ({ platform: "darwin" }),
  currentWindow: {},
  call: (...args: unknown[]) => bridge.call(...args),
  event: () => ({ on: bridge.on }),
}));
afterEach(() => vi.clearAllMocks());
describe("mygo lifecycle capability", () => {
  it("仅成功ready且tray可用才启用隐藏，teardown立即撤销能力", async () => {
    const adapter = createMygoPlatform();
    expect(adapter.capabilities.tray).toBe(false);
    bridge.call.mockResolvedValueOnce({ trayAvailable: true });
    await adapter.lifecycle?.ready({
      showCloseAppTip: true,
      closeAppMethod: "exit",
      labels: {
        show: "show",
        play: "play",
        pause: "pause",
        previous: "prev",
        next: "next",
        quit: "quit",
      },
    });
    expect(adapter.capabilities.tray).toBe(true);
    bridge.call.mockResolvedValueOnce(undefined);
    const teardown = adapter.lifecycle?.teardown();
    expect(adapter.capabilities.tray).toBe(false);
    await teardown;
    expect(bridge.call).toHaveBeenLastCalledWith("DesktopLifecycle.Teardown");
  });
  it.each([false, "failure"])("不可用或ready失败不暴露隐藏能力：%s", async (available) => {
    const adapter = createMygoPlatform();
    if (available === "failure") bridge.call.mockRejectedValueOnce(new Error("synthetic"));
    else bridge.call.mockResolvedValueOnce({ trayAvailable: false });
    const operation = adapter.lifecycle?.ready({
      showCloseAppTip: true,
      closeAppMethod: "hide",
      labels: {
        show: "show",
        play: "play",
        pause: "pause",
        previous: "prev",
        next: "next",
        quit: "quit",
      },
    });
    if (available === "failure") await expect(operation).rejects.toThrow("synthetic");
    else await operation;
    expect(adapter.capabilities.tray).toBe(false);
  });
});

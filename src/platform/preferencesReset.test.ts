import { describe, expect, it, vi } from "vitest";
import { executePreferencesReset } from "./preferencesReset";

function dependencies() {
  return {
    mode: "settings" as const,
    native: {
      reset: vi.fn(async () => ({
        pending: true,
        restartRequired: true,
        transactionId: "tx",
        mode: "settings" as const,
      })),
    },
    current: () => true,
    clearRenderer: vi.fn(async () => {}),
    restart: vi.fn(async () => {}),
    reportRendererFailure: vi.fn(),
  };
}

describe("executePreferencesReset", () => {
  it("does not clear or restart on native failure, and permits retry", async () => {
    const deps = dependencies();
    deps.native.reset.mockRejectedValueOnce(new Error("disk full"));
    expect(await executePreferencesReset(deps)).toEqual({ status: "native-failed" });
    expect(deps.clearRenderer).not.toHaveBeenCalled();
    expect(deps.restart).not.toHaveBeenCalled();
    expect(await executePreferencesReset(deps)).toEqual({
      status: "scheduled",
      rendererFailed: false,
      restartFailed: false,
    });
  });

  it("waits for the durable receipt, renderer persistence and then restart", async () => {
    const order: string[] = [];
    let release: (() => void) | undefined;
    const deps = dependencies();
    deps.native.reset.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      order.push("native committed");
      return {
        pending: true,
        restartRequired: true,
        transactionId: "tx",
        mode: "settings" as const,
      };
    });
    deps.clearRenderer.mockImplementation(async () => {
      order.push("renderer drained");
    });
    deps.restart.mockImplementation(async () => {
      order.push("restart");
    });
    const task = executePreferencesReset(deps);
    expect(order).toEqual([]);
    release?.();
    await task;
    expect(order).toEqual(["native committed", "renderer drained", "restart"]);
  });

  it("reports partial renderer failure without losing scheduled native reset", async () => {
    const deps = dependencies();
    deps.clearRenderer.mockRejectedValueOnce(new Error("IndexedDB failed"));
    deps.restart.mockRejectedValueOnce(new Error("owner revoked"));
    expect(await executePreferencesReset(deps)).toEqual({
      status: "scheduled",
      rendererFailed: true,
      restartFailed: true,
    });
    expect(deps.reportRendererFailure).toHaveBeenCalledOnce();
    expect(deps.restart).toHaveBeenCalledOnce();
  });

  it("never clears or restarts for a replaced renderer owner", async () => {
    const deps = dependencies();
    deps.current = () => false;
    expect(await executePreferencesReset(deps)).toEqual({ status: "stale", nativePending: false });
    expect(deps.native.reset).not.toHaveBeenCalled();
    expect(deps.clearRenderer).not.toHaveBeenCalled();
    expect(deps.restart).not.toHaveBeenCalled();
  });

  it("requires an explicit pending restart receipt", async () => {
    const deps = dependencies();
    deps.native.reset.mockResolvedValueOnce({
      pending: false,
      restartRequired: true,
      transactionId: "tx",
      mode: "settings" as const,
    });
    expect(await executePreferencesReset(deps)).toEqual({ status: "native-failed" });
    expect(deps.clearRenderer).not.toHaveBeenCalled();
  });
});

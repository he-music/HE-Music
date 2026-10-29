import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pending: vi.fn(),
  ack: vi.fn(),
  mount: vi.fn(),
  loaded: vi.fn(),
  failure: vi.fn(),
  drop: vi.fn(async () => {}),
}));
vi.mock("mygo-runtime", () => ({ isMyGo: () => true }));
vi.mock("@/platform/mygo.bindings", () => ({
  DesktopPlatform: {
    pendingPreferencesReset: mocks.pending,
    acknowledgePreferencesReset: mocks.ack,
  },
}));
vi.mock("@/platform", () => ({
  get platform() {
    mocks.loaded();
    return { kind: "mygo", gateway: {} };
  },
}));
vi.mock("@/bootstrap/window", () => ({ bootstrapWindow: mocks.mount }));
vi.mock("@/platform/gateway", () => ({ initializeGateway: async () => {} }));
vi.mock("localforage", () => ({ default: { dropInstance: mocks.drop } }));
vi.mock("@/platform/preferencesResetStartup", async (original) => ({
  ...(await original<typeof import("@/platform/preferencesResetStartup")>()),
  showPreferencesResetRecoveryFailure: mocks.failure,
}));
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("location", { hash: "#/" });
  vi.stubGlobal("window", { __HE_MUSIC_GATEWAY_ORIGIN__: "http://fixture.test" });
  vi.stubGlobal("localStorage", { removeItem: vi.fn(), clear: vi.fn() });
  vi.stubGlobal("sessionStorage", { clear: vi.fn() });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("actual production main waits for pending read and durable renderer acknowledgement before platform import or mount", async () => {
  let read: ((value: { transactionId: string; mode: string; phase: string }) => void) | undefined;
  let ack: (() => void) | undefined;
  mocks.pending.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        read = resolve;
      }),
  );
  mocks.ack.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        ack = resolve;
      }),
  );
  await import("@/main");
  await vi.waitFor(() => expect(mocks.pending).toHaveBeenCalledOnce());
  expect(mocks.loaded).not.toHaveBeenCalled();
  expect(mocks.mount).not.toHaveBeenCalled();
  read?.({ transactionId: "tx", mode: "settings", phase: "renderer" });
  await vi.waitFor(() => expect(mocks.ack).toHaveBeenCalledWith("tx"));
  expect(localStorage.removeItem).toHaveBeenCalledWith("setting-store");
  expect(mocks.loaded).not.toHaveBeenCalled();
  expect(mocks.mount).not.toHaveBeenCalled();
  ack?.();
  await vi.waitFor(() => expect(mocks.mount).toHaveBeenCalledWith("mygo", "#/"));
  expect(mocks.loaded).toHaveBeenCalledOnce();
});

it("actual production main blocks old app mount on partial recovery and exposes early retry UI", async () => {
  mocks.pending.mockResolvedValueOnce({ transactionId: "tx", mode: "all", phase: "renderer" });
  mocks.drop.mockRejectedValueOnce(new Error("IndexedDB blocked"));
  await import("@/main");
  await vi.waitFor(() => expect(mocks.failure).toHaveBeenCalledOnce());
  expect(mocks.ack).not.toHaveBeenCalled();
  expect(mocks.mount).not.toHaveBeenCalled();
  expect(mocks.loaded).not.toHaveBeenCalled();
});

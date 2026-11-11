import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mygo: true,
  platform: vi.fn(),
  storage: vi.fn(),
  recovery: vi.fn(),
  gateway: vi.fn(),
  mount: vi.fn(),
  failure: vi.fn(),
  storageFailure: vi.fn(),
  recoveryFailure: vi.fn(),
}));

vi.mock("mygo-runtime", () => ({ isMyGo: () => mocks.mygo }));
vi.mock("@/platform/mygo.bindings", () => ({
  DesktopPlatform: {},
  DesktopStorage: {},
  DesktopLog: {},
}));
vi.mock("@/platform/applicationLog", () => ({ installApplicationLogging: () => () => {} }));
vi.mock("@/platform/applicationStorage", () => ({ applicationStorage: {} }));
vi.mock("@/platform/applicationStorageStartup", async (original) => ({
  ...(await original<typeof import("@/platform/applicationStorageStartup")>()),
  prepareApplicationStorageBeforeMount: mocks.storage,
  showApplicationStorageRecoveryFailure: mocks.storageFailure,
}));
vi.mock("@/platform/preferencesResetStartup", async (original) => ({
  ...(await original<typeof import("@/platform/preferencesResetStartup")>()),
  recoverPreferencesResetBeforeMount: mocks.recovery,
  showPreferencesResetRecoveryFailure: mocks.recoveryFailure,
}));
vi.mock("@/platform", () => ({
  get platform() {
    return mocks.platform();
  },
}));
vi.mock("@/platform/gateway", () => ({ initializeGateway: mocks.gateway }));
vi.mock("./window", () => ({ bootstrapWindow: mocks.mount }));
vi.mock("./startupFailure", () => ({ showStartupFailure: mocks.failure }));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  mocks.mygo = true;
  mocks.platform.mockReturnValue({ kind: "mygo", gateway: {} });
  mocks.storage.mockResolvedValue(undefined);
  mocks.recovery.mockResolvedValue(undefined);
  mocks.gateway.mockResolvedValue(undefined);
  mocks.mount.mockResolvedValue(undefined);
  vi.stubGlobal("location", { hash: "#/" });
  vi.stubGlobal("window", { __HE_MUSIC_GATEWAY_ORIGIN__: "http://fixture.test" });
  vi.stubGlobal("sessionStorage", {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("本机网关缺失时显示启动失败入口，停止网关初始化和窗口挂载", async () => {
  vi.stubGlobal("window", {});
  await import("@/main");
  await vi.waitFor(() => expect(mocks.failure).toHaveBeenCalledOnce());
  expect(mocks.gateway).not.toHaveBeenCalled();
  expect(mocks.mount).not.toHaveBeenCalled();
  expect(console.error).toHaveBeenCalledWith("应用初始化失败", expect.any(Error));
});

it("网关初始化失败时显示启动失败入口，不继续挂载", async () => {
  mocks.gateway.mockRejectedValueOnce(new Error("gateway unavailable"));
  await import("@/main");
  await vi.waitFor(() => expect(mocks.failure).toHaveBeenCalledOnce());
  expect(mocks.mount).not.toHaveBeenCalled();
});

it("平台加载失败时显示启动失败入口", async () => {
  mocks.platform.mockImplementationOnce(() => {
    throw new Error("platform unavailable");
  });
  await import("@/main");
  await vi.waitFor(() => expect(mocks.failure).toHaveBeenCalledOnce());
  expect(mocks.gateway).not.toHaveBeenCalled();
  expect(mocks.mount).not.toHaveBeenCalled();
});

it.each([new Error("window unavailable"), "unknown failure"])(
  "窗口启动失败时保留日志并显示通用提示：%s",
  async (error) => {
    mocks.mount.mockRejectedValueOnce(error);
    await import("@/main");
    await vi.waitFor(() => expect(mocks.failure).toHaveBeenCalledOnce());
    expect(mocks.failure).toHaveBeenCalledWith();
    expect(console.error).toHaveBeenCalledWith("应用初始化失败", error);
  },
);

it("应用数据恢复失败时保留专用提示，不加载平台和旧数据", async () => {
  const { ApplicationStorageRecoveryError } = await import("@/platform/applicationStorageStartup");
  const error = new ApplicationStorageRecoveryError("data unavailable");
  mocks.storage.mockRejectedValueOnce(error);
  await import("@/main");
  await vi.waitFor(() => expect(mocks.storageFailure).toHaveBeenCalledWith(error));
  expect(mocks.failure).not.toHaveBeenCalled();
  expect(mocks.recovery).not.toHaveBeenCalled();
  expect(mocks.platform).not.toHaveBeenCalled();
  expect(mocks.mount).not.toHaveBeenCalled();
});

it("设置重置恢复失败时保留专用提示，不加载平台和旧设置", async () => {
  const { PreferencesResetRecoveryError } = await import("@/platform/preferencesResetStartup");
  const error = new PreferencesResetRecoveryError("reset incomplete");
  mocks.recovery.mockRejectedValueOnce(error);
  await import("@/main");
  await vi.waitFor(() => expect(mocks.recoveryFailure).toHaveBeenCalledWith(error));
  expect(mocks.failure).not.toHaveBeenCalled();
  expect(mocks.storageFailure).not.toHaveBeenCalled();
  expect(mocks.platform).not.toHaveBeenCalled();
  expect(mocks.mount).not.toHaveBeenCalled();
});

it("成功启动不显示失败界面", async () => {
  await import("@/main");
  await vi.waitFor(() => expect(mocks.mount).toHaveBeenCalledWith("mygo", "#/"));
  expect(mocks.gateway).toHaveBeenCalledOnce();
  expect(mocks.failure).not.toHaveBeenCalled();
  expect(mocks.storageFailure).not.toHaveBeenCalled();
  expect(mocks.recoveryFailure).not.toHaveBeenCalled();
});

it.each(["web", "lyrics"] as const)("%s 启动失败不执行主窗口原生恢复", async (kind) => {
  if (kind === "web") {
    mocks.mygo = false;
    mocks.platform.mockReturnValue({ kind: "web" });
  } else {
    vi.stubGlobal("location", { hash: "#/desktop-lyric" });
  }
  mocks.mount.mockRejectedValueOnce(new Error("mount failed"));
  await import("@/main");
  await vi.waitFor(() => expect(mocks.failure).toHaveBeenCalledOnce());
  expect(mocks.storage).not.toHaveBeenCalled();
  expect(mocks.recovery).not.toHaveBeenCalled();
  expect(mocks.gateway).not.toHaveBeenCalled();
  expect(mocks.mount).toHaveBeenCalledOnce();
});

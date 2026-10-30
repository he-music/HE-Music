import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const platform: { kind: string; files?: object; capabilities: { localMusic: boolean } } = {
    kind: "mygo",
    files: {},
    capabilities: { localMusic: false },
  };
  return { platform, electron: false, warning: vi.fn() };
});
vi.mock("vue-router", async (original) => {
  const actual = await original<typeof import("vue-router")>();
  return { ...actual, createWebHashHistory: () => actual.createMemoryHistory() };
});
vi.mock("@/platform", () => ({ platform: mocks.platform }));
vi.mock("@/utils/env", () => ({
  get isElectron() {
    return mocks.electron;
  },
}));
vi.mock("@/utils/modal", () => ({ openUserLogin: vi.fn() }));
vi.mock("@/utils/auth", () => ({ isLogin: () => true }));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/stores", () => ({
  usePlatformStore: () => ({ platforms: [{}], loadPlatforms: vi.fn() }),
  useStatusStore: () => ({ searchInputValue: "" }),
}));
vi.mock("./routes", () => {
  const component = { render: () => null };
  return {
    default: [
      { path: "/403", name: "403", component },
      {
        path: "/download",
        name: "download",
        meta: { needApp: true },
        component,
        children: [
          { path: "downloading", name: "download-downloading", component },
          { path: "downloaded", name: "download-downloaded", component },
        ],
      },
      {
        path: "/local",
        name: "local",
        meta: { needApp: true },
        component,
        children: [{ path: "songs", name: "local-songs", component }],
      },
      { path: "/desktop-only", name: "desktop-only", meta: { needApp: true }, component },
    ],
  };
});
beforeEach(() => {
  vi.resetModules();
  mocks.platform.kind = "mygo";
  mocks.platform.files = {};
  mocks.platform.capabilities.localMusic = false;
  mocks.electron = false;
  mocks.warning.mockClear();
  vi.stubGlobal("window", { $message: { warning: mocks.warning } });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

it.each(["download-downloading", "download-downloaded", "local", "local-songs"])(
  "mygo 的 %s 在文件会话尚未ready时仍能进入客户端页面",
  async (name) => {
    const router = (await import("./index")).default;
    await router.push({ name });
    expect(router.currentRoute.value.name).toBe(name);
    expect(mocks.warning).not.toHaveBeenCalled();
  },
);
it("文件路由例外不放宽Web、无文件provider或其它桌面路由", async () => {
  const router = (await import("./index")).default;
  for (const kind of ["web", "mygo"]) {
    mocks.platform.kind = kind;
    if (kind === "mygo") delete mocks.platform.files;
    for (const name of ["download-downloading", "local", "local-songs"]) {
      await router.push({ name });
      expect(router.currentRoute.value.name).toBe("403");
    }
  }
  mocks.platform.files = {};
  await router.push({ name: "desktop-only" });
  expect(router.currentRoute.value.name).toBe("403");
  mocks.platform.kind = "mygo";
  await router.push({ name: "local" });
  expect(router.currentRoute.value.name).toBe("local");
});
it("Electron 的现有桌面路由入口保持可用", async () => {
  mocks.platform.kind = "electron";
  mocks.electron = true;
  delete mocks.platform.files;
  const router = (await import("./index")).default;
  await router.push({ name: "download-downloading" });
  expect(router.currentRoute.value.name).toBe("download-downloading");
  await router.push({ name: "desktop-only" });
  expect(router.currentRoute.value.name).toBe("desktop-only");
});

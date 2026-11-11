import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const platform: { kind: string; files?: object; capabilities: { localMusic: boolean } } = {
    kind: "mygo",
    files: {},
    capabilities: { localMusic: false },
  };
  return { platform, electron: false, loggedIn: true, warning: vi.fn() };
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
vi.mock("@/utils/auth", () => ({ isLogin: () => mocks.loggedIn }));
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
      {
        path: "/local-playlist",
        name: "local-playlist",
        meta: { needApp: true, offline: true },
        component,
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
  mocks.loggedIn = true;
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

it("本地歌单独立路由不要求登录，并在每次导航校验歌曲列表 ID", async () => {
  const router = (await import("./index")).default;
  mocks.loggedIn = false;
  await router.push({ name: "local-playlist", query: { id: "first" } });
  expect(router.currentRoute.value.name).toBe("local-playlist");
  await router.push({ name: "local-playlist", query: { id: "second" } });
  expect(router.currentRoute.value.query.id).toBe("second");
  await router.push({ name: "local-playlist", query: {} });
  expect(router.currentRoute.value.name).toBe("403");
  mocks.platform.kind = "web";
  await router.push({ name: "local-playlist", query: { id: "first" } });
  expect(router.currentRoute.value.name).toBe("403");
});

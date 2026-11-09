import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NativeRendererStorage } from "@/platform/applicationStorage";

const storage = vi.hoisted(() => ({ getItem: vi.fn(), setItem: vi.fn() }));
vi.mock("@/platform/applicationStorage", async (original) => ({
  ...(await original<typeof import("@/platform/applicationStorage")>()),
  applicationStorage: storage,
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  storage.getItem.mockReturnValue(null);
  storage.setItem.mockImplementation(() => {});
});
afterEach(() => vi.unstubAllGlobals());

describe("客户端实例标识", () => {
  it("随机生成并持久化，模块重载和退出清理用户数据后仍复用", async () => {
    const values = new Map<string, string>();
    storage.getItem.mockImplementation((key) => values.get(key));
    storage.setItem.mockImplementation((key, value) => values.set(key, value));
    const first = await import("./clientInstance");
    const id = first.getClientInstanceID();
    expect(first.validClientInstanceID(id)).toBe(true);
    expect(first.getClientInstanceID()).toBe(id);
    expect(values.has("data-store")).toBe(false);
    vi.resetModules();
    expect((await import("./clientInstance")).getClientInstanceID()).toBe(id);
  });

  it.each(["", "with space", "tab\t", "中文", "x".repeat(129), "\u007f"])(
    "无效存储值 %j 重新生成",
    async (invalid) => {
      storage.getItem.mockReturnValue(invalid);
      const instance = await import("./clientInstance");
      expect(instance.validClientInstanceID(invalid)).toBe(false);
      const id = instance.getClientInstanceID();
      expect(instance.validClientInstanceID(id)).toBe(true);
      expect(storage.setItem).toHaveBeenCalledWith("he-client-instance-id", id);
    },
  );

  it("存储读写均异常仍生成稳定的内存标识", async () => {
    storage.getItem.mockImplementation(() => {
      throw new Error("unavailable");
    });
    storage.setItem.mockImplementation(() => {
      throw new Error("unavailable");
    });
    const instance = await import("./clientInstance");
    const id = instance.getClientInstanceID();
    expect(instance.validClientInstanceID(id)).toBe(true);
    expect(instance.getClientInstanceID()).toBe(id);
  });

  it("随机源不可用时返回缺失值交由后端兼容，不阻断请求", async () => {
    vi.stubGlobal("crypto", {});
    expect((await import("./clientInstance")).getClientInstanceID()).toBeUndefined();
  });

  it("mygo renderer 存储保留独立 key 并写入 native namespace", async () => {
    const native = {
      put: vi.fn(async () => {}),
      remove: vi.fn(),
      clear: vi.fn(),
      keys: vi.fn(),
      get: vi.fn(),
      localSnapshot: vi.fn(),
    };
    const renderer = new NativeRendererStorage({}, native);
    storage.getItem.mockImplementation((key) => renderer.getItem(key));
    storage.setItem.mockImplementation((key, value) => renderer.setItem(key, value));
    const id = (await import("./clientInstance")).getClientInstanceID();
    await renderer.flush();
    expect(native.put).toHaveBeenCalledWith("renderer", "he-client-instance-id", {
      kind: "text",
      value: id,
      mediaType: "",
    });
  });

  it("只接受配置后端的 origin 和路径，重试使用原始地址", async () => {
    const { isHemusicRequest } = await import("./clientInstance");
    const base = "https://he.invalid/api";
    expect(isHemusicRequest({ url: "/v1/platforms" }, base)).toBe(true);
    expect(isHemusicRequest({ url: "https://he.invalid/api/v1/song" }, base)).toBe(true);
    expect(
      isHemusicRequest(
        { url: "http://127.0.0.1/__api/hemusic/v1/platforms", gatewayOriginalURL: "/v1/platforms" },
        base,
      ),
    ).toBe(true);
    for (const url of [
      "https://cdn.invalid/api/song",
      "//cdn.invalid/api/song",
      "https://he.invalid/api-other/song",
      "https://he.invalid/elsewhere",
      "https://he.invalid/api/../secret",
    ]) {
      expect(isHemusicRequest({ url }, base)).toBe(false);
    }
    expect(isHemusicRequest({ url: "/v1/song", baseURL: "https://cdn.invalid" }, base)).toBe(false);
  });
});

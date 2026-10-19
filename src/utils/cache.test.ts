import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCacheData } from "./cache";

describe("getCacheData", () => {
  const entries = new Map<string, string>();
  const storage = {
    getItem: vi.fn((key: string) => entries.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => entries.set(key, value)),
  };

  beforeEach(() => {
    entries.clear();
    vi.clearAllMocks();
    vi.stubGlobal("window", { sessionStorage: storage });
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("复用永久缓存并保留请求参数", async () => {
    const fetch = vi.fn(async (id: string) => ({ id }));
    const options = { key: "permanent", time: -1 };
    await expect(getCacheData(fetch, options, "song")).resolves.toEqual({ id: "song" });
    await expect(getCacheData(fetch, options, "song")).resolves.toEqual({ id: "song" });
    expect(fetch).toHaveBeenCalledExactlyOnceWith("song");
  });

  it("有效期内复用数据，过期后重新请求", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const fetch = vi.fn(async () => "fresh");
    const options = { key: "timed", time: 1 };
    await getCacheData(fetch, options);
    vi.mocked(Date.now).mockReturnValue(60_999);
    await getCacheData(fetch, options);
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.mocked(Date.now).mockReturnValue(61_000);
    await getCacheData(fetch, options);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  const invalidEntries = [
    "{invalid",
    "null",
    "[]",
    JSON.stringify({ expiry: 0 }),
    JSON.stringify({ value: "old", expiry: "later" }),
  ];
  it.each(invalidEntries)("缓存内容无效时回退请求：%s", async (value) => {
    entries.set("broken", value);
    const fetch = vi.fn(async () => "fresh");
    await expect(getCacheData(fetch, { key: "broken", time: 1 })).resolves.toBe("fresh");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("存储访问被禁用时仍能请求", async () => {
    vi.stubGlobal("window", {
      get sessionStorage() {
        throw new Error("SecurityError");
      },
    });
    await expect(getCacheData(async () => "fresh", { key: "disabled", time: 1 })).resolves.toBe(
      "fresh",
    );
  });

  it("缓存写入失败时保留已成功的请求结果", async () => {
    storage.setItem.mockImplementationOnce(() => {
      throw new Error("QuotaExceededError");
    });
    await expect(getCacheData(async () => "fresh", { key: "quota", time: 1 })).resolves.toBe(
      "fresh",
    );
  });

  it("跳过缓存时不读取旧值，并刷新缓存", async () => {
    entries.set("refresh", JSON.stringify({ value: "old", expiry: 0 }));
    await expect(
      getCacheData(async () => "fresh", { key: "refresh", time: 1, useCache: false }),
    ).resolves.toBe("fresh");
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(JSON.parse(entries.get("refresh")!).value).toBe("fresh");
  });

  it("兼容已有 expiry=0 的永久缓存", async () => {
    entries.set("legacy", JSON.stringify({ value: "old", expiry: 0 }));
    const fetch = vi.fn(async () => "fresh");
    await expect(getCacheData(fetch, { key: "legacy", time: 1 })).resolves.toBe("old");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("接口失败时继续向调用方抛出错误", async () => {
    const error = new Error("offline");
    await expect(
      getCacheData(() => Promise.reject(error), { key: "failed", time: 1 }),
    ).rejects.toBe(error);
    expect(storage.setItem).not.toHaveBeenCalled();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./env", () => ({ isElectron: false, isMac: false, isWin: false, isLinux: false }));

import { getDeviceId } from "./device";

afterEach(() => vi.unstubAllGlobals());

describe("getDeviceId", () => {
  it("在本地 HTTP 下没有 randomUUID 时使用 getRandomValues 生成并复用 UUID", () => {
    const values = vi.fn((bytes: Uint8Array) => {
      bytes.set(Array.from({ length: 16 }, (_, index) => index));
      return bytes;
    });
    const storage = new Map<string, string>();
    vi.stubGlobal("crypto", { getRandomValues: values });
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });

    const id = getDeviceId();
    expect(id).toMatch(/^web_\w+_00010203-0405-4607-8809-0a0b0c0d0e0f$/);
    expect(getDeviceId()).toBe(id);
    expect(values).toHaveBeenCalledOnce();
  });
});

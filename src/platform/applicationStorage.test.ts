import { afterEach, expect, it, vi } from "vitest";
import {
  NativeRendererStorage,
  encodeApplicationValue,
  decodeApplicationValue,
  type ApplicationStorageProvider,
} from "./applicationStorage";

function fixture() {
  const data = new Map<string, string>();
  const native: ApplicationStorageProvider = {
    localSnapshot: vi.fn(async () => Object.fromEntries(data)),
    get: vi.fn(async () => null),
    put: vi.fn(async (_namespace, key, value) => {
      data.set(key, value.value);
    }),
    remove: vi.fn(async (_namespace, key) => {
      data.delete(key);
    }),
    clear: vi.fn(async () => {
      data.clear();
    }),
    keys: vi.fn(async () => [...data.keys()]),
  };
  return { native, data };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("hydrates synchronously, coalesces writes and makes removals durable", async () => {
  const { native, data } = fixture();
  const storage = new NativeRendererStorage({ "setting-store": "{}" }, native);
  expect(storage.getItem("setting-store")).toBe("{}");
  storage.setItem("setting-store", "first");
  storage.setItem("setting-store", "last");
  expect(storage.getItem("setting-store")).toBe("last");
  await storage.flush();
  expect(native.put).toHaveBeenCalledOnce();
  expect(data.get("setting-store")).toBe("last");
  storage.removeItem("setting-store");
  await storage.flush();
  expect(data.size).toBe(0);
});

it("replays a same-value update after a clear during an in-flight put", async () => {
  const { native, data } = fixture();
  let finish: (() => void) | undefined;
  vi.mocked(native.put).mockImplementationOnce(async (_namespace, key, value) => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    data.set(key, value.value);
  });
  const storage = new NativeRendererStorage({}, native);
  storage.setItem("setting-store", "same");
  await vi.waitFor(() => expect(finish).toBeDefined());
  storage.clear();
  storage.setItem("setting-store", "same");
  finish?.();
  await storage.flush();
  expect(data.get("setting-store")).toBe("same");
  expect(native.clear).toHaveBeenCalledOnce();
  expect(native.put).toHaveBeenCalledTimes(2);
});

it("preserves failed writes for an explicit retry and reports the failed flush", async () => {
  const { native, data } = fixture();
  vi.mocked(native.put).mockRejectedValueOnce(new Error("disk full"));
  const report = vi.fn();
  const storage = new NativeRendererStorage({}, native, report);
  storage.setItem("setting-store", "pending");
  await expect(storage.flush()).rejects.toThrow("disk full");
  expect(report).toHaveBeenCalledOnce();
  expect(storage.getItem("setting-store")).toBe("pending");
  await storage.flush();
  expect(data.get("setting-store")).toBe("pending");
});

it("round trips JSON and background blobs without data URLs or type loss", async () => {
  const json = { songs: [{ id: 1 }], empty: null };
  expect(decodeApplicationValue(await encodeApplicationValue(json))).toEqual(json);
  const blob = new Blob([new Uint8Array([0, 255, 10, 128])], { type: "image/png" });
  const result = decodeApplicationValue(await encodeApplicationValue(blob));
  expect(result).toBeInstanceOf(Blob);
  if (!(result instanceof Blob)) throw new Error("missing blob");
  expect(result.type).toBe("image/png");
  expect(await result.arrayBuffer()).toEqual(await blob.arrayBuffer());
});

it("keeps Web storage unchanged and starts a mygo instance from the Go snapshot only", async () => {
  const web = { getItem: vi.fn(() => "browser"), setItem: vi.fn() };
  vi.stubGlobal("localStorage", web);
  const module = await import("./applicationStorage");
  expect(module.applicationStorage.getItem("setting-store")).toBe("browser");
  const { native } = fixture();
  vi.mocked(native.localSnapshot).mockResolvedValue({ "setting-store": '{"language":"en"}' });
  await module.initializeApplicationStorage(native);
  expect(module.applicationStorage.getItem("setting-store")).toBe('{"language":"en"}');
  module.applicationStorage.setItem("setting-store", "{}");
  await module.flushApplicationWrites();
  expect(web.getItem).toHaveBeenCalledOnce();
  expect(web.setItem).not.toHaveBeenCalled();
  expect(native.put).toHaveBeenCalledWith("renderer", "setting-store", {
    kind: "text",
    value: "{}",
    mediaType: "",
  });
});

it("does not install a damaged native snapshot or overwrite it with defaults", async () => {
  const { native } = fixture();
  vi.mocked(native.localSnapshot).mockResolvedValue({ "setting-store": "broken" });
  const module = await import("./applicationStorage");
  await expect(module.initializeApplicationStorage(native)).rejects.toThrow();
  expect(native.put).not.toHaveBeenCalled();
});

it("keeps failed database writes ordered without blocking another namespace", async () => {
  const { native, data } = fixture();
  const module = await import("./applicationStorage");
  await module.initializeApplicationStorage(native);
  const music = module.createApplicationDatabase({ name: "music-data", storeName: "music" });
  const user = module.createApplicationDatabase({ name: "user-data", storeName: "user" });
  vi.mocked(native.put).mockRejectedValueOnce(new Error("disk full"));
  await expect(music.setItem("playList", [1])).rejects.toThrow("disk full");
  await expect(music.setItem("historyList", [2])).rejects.toThrow("pending retry");
  await user.setItem("songs", [3]);
  await module.flushApplicationWrites();
  expect(data.get("playList")).toBe("[1]");
  expect(data.get("historyList")).toBe("[2]");
  expect(data.get("songs")).toBe("[3]");
});

it("never resurrects pre-clear writes after a failed clear is retried", async () => {
  const { native, data } = fixture();
  const module = await import("./applicationStorage");
  await module.initializeApplicationStorage(native);
  const db = module.createApplicationDatabase({ name: "music-data", storeName: "music" });
  vi.mocked(native.put).mockRejectedValueOnce(new Error("disk full"));
  await expect(db.setItem("old", [1])).rejects.toThrow();
  vi.mocked(native.clear).mockRejectedValueOnce(new Error("busy"));
  await expect(db.clear()).rejects.toThrow("busy");
  await expect(db.setItem("new", [2])).rejects.toThrow("pending retry");
  await module.flushApplicationWrites();
  expect(data.has("old")).toBe(false);
  expect(data.get("new")).toBe("[2]");
});

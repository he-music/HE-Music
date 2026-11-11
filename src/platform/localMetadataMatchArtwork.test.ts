import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadMetadataMatchArtwork } from "./localMetadataMatchArtwork";
import { initializeGateway } from "./gateway";
import { loadSystemMediaArtwork } from "./systemMediaArtwork";

vi.mock("@/utils/request", () => ({
  default: vi.fn(),
  API_URL: "http://localhost:9090/api",
  requestHemusic: vi.fn(),
}));
vi.mock("@/utils/env", () => ({ isElectron: false }));

const fixture = (name: string) =>
  new Uint8Array(readFileSync(resolve(__dirname, "../test/fixtures/metadata-match", name)));
const original = fixture("original-4096.png");
const thumbnail = fixture("thumb-1024.png");
const fetchMock = vi.fn<typeof fetch>();
const targets: string[] = [];
const revoke = vi.fn();
const option = {
  id: "song:alpha",
  platform: "a",
  title: "chosen",
  artists: [],
  album: "",
  cover: "https://covers.fixture.invalid/{x}/{y}.jpg",
};
let decoded = 0;
let failDecode = false;

beforeEach(async () => {
  vi.resetAllMocks();
  targets.length = 0;
  decoded = 0;
  failDecode = false;
  vi.stubGlobal("window", { __HE_MUSIC_GATEWAY_ORIGIN__: "http://127.0.0.1:4444/session" });
  vi.stubGlobal("location", { origin: "https://fixture.invalid" });
  await initializeGateway({ configure: async () => {} }, "http://localhost:9090/api");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(async (input) => {
    targets.push(String(input));
    return new Response(thumbnail);
  });
  const blobs = new Map<string, Blob>();
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    if (!(blob instanceof Blob)) throw new Error("Expected artwork Blob");
    const key = `blob:fixture-${blobs.size}`;
    blobs.set(key, blob);
    return key;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(revoke);
  // CPU Image boundary only: no browser decoder is available in the Node host.
  vi.stubGlobal(
    "Image",
    class {
      naturalWidth = 0;
      naturalHeight = 0;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(value: string) {
        const blob = blobs.get(value);
        if (!blob) return;
        void blob.arrayBuffer().then((bytes) => {
          decoded++;
          const view = new DataView(bytes);
          this.naturalWidth = view.getUint32(16);
          this.naturalHeight = view.getUint32(20);
          if (failDecode) this.onerror?.();
          else this.onload?.();
        });
      }
    },
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("loads a platform size template through the existing gateway and real budgeted loader", async () => {
  fetchMock.mockResolvedValueOnce(new Response(original));
  await expect(
    loadSystemMediaArtwork(
      "https://covers.fixture.invalid/original.jpg",
      new AbortController().signal,
    ),
  ).rejects.toThrow("dimensions exceed budget");
  expect(decoded).toBe(0);
  targets.length = 0;
  const signal = new AbortController().signal;
  const picture = await loadMetadataMatchArtwork(option, [300, 1024, 4096], "", false, signal);
  expect(targets).toEqual([
    "http://127.0.0.1:4444/session/__proxy/https://covers.fixture.invalid/1024/1024.jpg",
  ]);
  expect(picture).toEqual({
    MIME: "image/png",
    Type: 3,
    Description: "",
    Data: Buffer.from(thumbnail).toString("base64"),
  });
  expect(decoded).toBe(1);
  expect(revoke).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls.at(-1)?.[1]).toEqual({
    signal,
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
});

it("routes a missing cover to the configured localhost HE-Music API, preserving path prefix and token", async () => {
  await loadMetadataMatchArtwork(
    { ...option, cover: "" },
    [],
    "fixture-token",
    true,
    new AbortController().signal,
  );
  const url = new URL(targets[0]);
  expect(url.origin + url.pathname).toBe(
    "http://127.0.0.1:4444/session/__api/hemusic/v1/song/cover",
  );
  expect(Object.fromEntries(url.searchParams)).toEqual({
    id: "song:alpha",
    platform: "a",
    quality: "1024",
    redirect: "true",
    token: "fixture-token",
  });
});

it("does not create a URL when cover capability or a bounded template size is missing", async () => {
  const signal = new AbortController().signal;
  expect(
    await loadMetadataMatchArtwork({ ...option, cover: "" }, [], "", false, signal),
  ).toBeUndefined();
  expect(await loadMetadataMatchArtwork(option, [4096], "", true, signal)).toBeUndefined();
  expect(fetchMock).not.toHaveBeenCalled();
});

it("does not apply legacy URL rules to platform artwork", async () => {
  await loadMetadataMatchArtwork(
    { ...option, cover: "http://covers.fixture.invalid/image.jpg" },
    [],
    "",
    false,
    new AbortController().signal,
  );
  expect(targets).toEqual([
    "http://127.0.0.1:4444/session/__proxy/http://covers.fixture.invalid/image.jpg",
  ]);
});

it("rejects a provider ignoring the requested size", async () => {
  fetchMock.mockResolvedValueOnce(new Response(original));
  await expect(
    loadMetadataMatchArtwork(option, [], "", false, new AbortController().signal),
  ).rejects.toThrow("dimensions exceed budget");
  expect(decoded).toBe(0);
});

it("rejects decode failure and releases the temporary cover URL", async () => {
  failDecode = true;
  await expect(
    loadMetadataMatchArtwork(option, [], "", false, new AbortController().signal),
  ).rejects.toThrow("Invalid artwork image");
  expect(revoke).toHaveBeenCalledTimes(1);
});

it("rejects oversized bytes and unsupported formats without decoding", async () => {
  fetchMock.mockResolvedValueOnce(new Response(new Uint8Array(2 * 1024 * 1024 + 1)));
  await expect(
    loadMetadataMatchArtwork(option, [], "", false, new AbortController().signal),
  ).rejects.toThrow("exceeds budget");
  fetchMock.mockResolvedValueOnce(new Response("GIF89a"));
  await expect(
    loadMetadataMatchArtwork(option, [], "", false, new AbortController().signal),
  ).rejects.toThrow("Unsupported artwork format");
  expect(decoded).toBe(0);
});

it("cancels before fetching and refuses raw localhost artwork", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(loadMetadataMatchArtwork(option, [], "", false, controller.signal)).rejects.toThrow(
    "cancelled",
  );
  await expect(
    loadMetadataMatchArtwork(
      { ...option, cover: "http://localhost:9090/private" },
      [],
      "",
      false,
      new AbortController().signal,
    ),
  ).rejects.toThrow("controlled gateway");
  expect(fetchMock).not.toHaveBeenCalled();
});

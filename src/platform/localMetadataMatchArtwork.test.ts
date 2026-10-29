import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMetadataMatchAPI } from "./localMetadataMatchAPI";
import { loadSystemMediaArtwork } from "./systemMediaArtwork";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
// Keep real matchSong/neteaseSongLyric, API normalization, gateway and artwork loader.
vi.mock("@/utils/request", () => ({
  default: mocks.request,
  API_URL: "",
  requestHemusic: vi.fn(),
}));
vi.mock("@/utils/env", () => ({ isElectron: false }));

// Go image/png encoded synthetic grayscale images. The URL suffix does not select MIME.
const fixture = (name: string) =>
  new Uint8Array(readFileSync(resolve(__dirname, "../test/fixtures/metadata-match", name)));
const original = fixture("original-4096.png");
const thumbnail = fixture("thumb-1024.png");
const fetchMock = vi.fn<typeof fetch>();
const targets: string[] = [];
const settings = { downloadLyric: false, downloadLyricTran: false, downloadLyricRoma: false };
const query = {
  title: "local",
  artist: "local artist",
  album: "local album",
  duration: 12,
  md5: "a".repeat(32),
};
const revoke = vi.fn();
let decoded = 0;
let failDecode = false;

beforeEach(() => {
  vi.resetAllMocks();
  targets.length = 0;
  decoded = 0;
  failDecode = false;
  vi.stubGlobal("window", { __HE_MUSIC_GATEWAY_ORIGIN__: "http://127.0.0.1:4444/session" });
  vi.stubGlobal("location", { origin: "https://fixture.invalid" });
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(async (input) => {
    const request = new URL(String(input));
    expect(request.pathname).toBe("/session/__proxy");
    const target = Buffer.from(request.searchParams.get("target") ?? "", "base64url").toString();
    targets.push(target);
    return new Response(
      new URL(target).searchParams.get("param") === "1024y1024" ? thumbnail : original,
    );
  });
  mocks.request.mockImplementation(async (config: { url: string }) => {
    if (config.url === "/search/match")
      return {
        result: {
          songs: [
            {
              id: 42,
              name: "matched",
              artist: { name: "solo artist" },
              album: { name: "album", picUrl: "http://covers.fixture.invalid/original.jpg" },
            },
          ],
        },
      };
    if (config.url === "/lyric/new") return { lrc: { lyric: "matched lyric" } };
    throw new Error(`Unexpected API route ${config.url}`);
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

it("rejects a valid oversized original but loads its legacy 1024 thumbnail through real API and loader", async () => {
  await expect(
    loadSystemMediaArtwork(
      "https://covers.fixture.invalid/original.jpg",
      new AbortController().signal,
    ),
  ).rejects.toThrow("dimensions exceed budget");
  expect(decoded).toBe(0);
  expect(targets).toEqual(["https://covers.fixture.invalid/original.jpg"]);
  targets.length = 0;
  const api = createMetadataMatchAPI(() => settings);
  const options = await api.search(query);
  const chosen = options[0];
  expect(chosen).toBeDefined();
  const signal = new AbortController().signal;
  const draft = await api.details(chosen, signal);
  expect(mocks.request).toHaveBeenNthCalledWith(1, { url: "/search/match", params: query });
  expect(mocks.request).toHaveBeenNthCalledWith(2, { url: "/lyric/new", params: { id: 42 } });
  expect(targets).toEqual(["https://covers.fixture.invalid/original.jpg?param=1024y1024"]);
  expect(draft).toEqual({
    title: "matched",
    artists: ["solo artist"],
    album: "album",
    comment: "",
    lyrics: "matched lyric",
    picture: {
      MIME: "image/png",
      Type: 3,
      Description: "",
      Data: Buffer.from(thumbnail).toString("base64"),
    },
  });
  expect(decoded).toBe(1);
  expect(revoke).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls.at(-1)?.[1]).toEqual({
    signal,
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
});

it("still rejects oversized bytes if a thumbnail provider ignores the size request", async () => {
  fetchMock.mockResolvedValueOnce(new Response(original));
  const api = createMetadataMatchAPI(() => settings);
  const options = await api.search(query);
  await expect(api.details(options[0], new AbortController().signal)).rejects.toThrow(
    "dimensions exceed budget",
  );
  expect(decoded).toBe(0);
});

it("still rejects decode failure and releases the temporary cover URL", async () => {
  failDecode = true;
  const api = createMetadataMatchAPI(() => settings);
  const options = await api.search(query);
  await expect(api.details(options[0], new AbortController().signal)).rejects.toThrow(
    "Invalid artwork image",
  );
  expect(revoke).toHaveBeenCalledTimes(1);
});

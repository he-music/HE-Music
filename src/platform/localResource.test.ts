import { afterEach, expect, it, vi } from "vitest";
import { joinLocalFilePath } from "./localAudioURL";
import { localResourceURL, readLocalLyrics } from "./localResource";
import { localEntry } from "@/test/fixtures/localMedia";

afterEach(() => vi.unstubAllGlobals());

it.each([
  "/Music/中文 #100% &?.flac",
  "/Music/back\\slash.mp3",
  "C:\\Music\\中文 #1.flac",
  "\\\\server\\share\\my song.mp3",
])("encodes the absolute audio path %s in the HTTP route", (path) => {
  vi.stubGlobal("window", { __HE_MUSIC_GATEWAY_ORIGIN__: "http://127.0.0.1:1234/session" });
  const url = localResourceURL("audio", localEntry(path))!;
  expect(new URL(url).pathname).toBe("/session/__local/audio");
  expect(new URL(url).searchParams.get("path")).toBe(path);
});

it("forms new downloaded paths for filesystem roots and nested Windows folders", () => {
  expect(joinLocalFilePath("/", "album/song.mp3")).toBe("/album/song.mp3");
  expect(joinLocalFilePath("D:\\", "Artist/Album/song.mp3")).toBe("D:\\Artist\\Album\\song.mp3");
});

it("keeps display URLs stable for an entry and refreshes same-ref sidecars on rescan", () => {
  vi.stubGlobal("window", { __HE_MUSIC_GATEWAY_ORIGIN__: "http://127.0.0.1:1234/session" });
  const entry = localEntry("C:\\Music\\song #100%.mp3");
  const first = localResourceURL("artwork", entry)!;
  expect(localResourceURL("artwork", entry)).toBe(first);
  expect(new URL(first).searchParams.get("path")).toBe(entry.path);
  expect(new URL(first).pathname).toBe("/session/__local/artwork");
  expect(localResourceURL("artwork", { ...entry })).not.toBe(first);
  expect(localResourceURL("lyrics", entry)).toContain("/__local/lyrics?");
});

it("loads full lyric text over HTTP and handles missing lyrics", async () => {
  vi.stubGlobal("window", { __HE_MUSIC_GATEWAY_ORIGIN__: "http://127.0.0.1:1234/session" });
  const lyric = "[00:00.00]" + "完整歌词".repeat(500);
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response(lyric))
    .mockResolvedValueOnce(new Response(null, { status: 404 }));
  vi.stubGlobal("fetch", fetcher);
  const entry = localEntry();
  expect(await readLocalLyrics(entry)).toBe(lyric);
  expect(fetcher).toHaveBeenCalledWith(localResourceURL("lyrics", entry), { credentials: "omit" });
  expect(await readLocalLyrics(entry)).toBe("");
});

it("recognizes only local audio URLs on the active gateway and skips redundant CORS probing", async () => {
  vi.stubGlobal("window", { __HE_MUSIC_GATEWAY_ORIGIN__: "http://127.0.0.1:1234/session" });
  const { isMygoGatewayResourceUrl } = await import("./gateway");
  const { canUseWebAudioSource } = await import("@/utils/audioCapability");
  const fetcher = vi.fn();
  const url = localResourceURL("audio", localEntry())!;
  expect(isMygoGatewayResourceUrl(url)).toBe(true);
  expect(await canUseWebAudioSource(url, { fetcher })).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
  for (const invalid of [
    url.replace("session", "old-session"),
    url.replace(":1234", ":9999"),
    url.replace("path=", "other="),
    url.replace("audio?", "unknown?"),
  ]) {
    expect(isMygoGatewayResourceUrl(invalid)).toBe(false);
  }
});

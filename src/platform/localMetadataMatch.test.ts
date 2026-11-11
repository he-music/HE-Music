import { describe, expect, it, vi } from "vitest";
import {
  LocalMetadataMatch,
  type MetadataMatchAPI,
  type MetadataMatchCandidate,
  type MetadataMatchDraft,
  type MetadataMatchResourceLoader,
  type MetadataMatchResources,
} from "./localMetadataMatch";
import type { Info } from "./mygo.bindings";

const option: MetadataMatchCandidate = {
  id: "90071992547409931",
  platform: "a",
  title: "matched",
  artists: ["artist"],
  album: "album",
  comment: "alias",
  cover: "",
};
const resources: MetadataMatchResources = { lyrics: "lyric" };
const draft: MetadataMatchDraft = {
  title: option.title,
  artists: option.artists,
  album: option.album,
  comment: option.comment,
  ...resources,
};
const info: Info = {
  Container: "MP3",
  Title: "local",
  Artists: ["one", "two"],
  Album: "local album",
  AlbumArtists: [],
  Comment: "",
  Lyrics: "",
  Pictures: [],
  PicturesLoaded: true,
  DurationSeconds: 12.5,
  BitrateKbps: 128,
  SampleRateHz: 44100,
  Channels: 2,
  BitsPerSample: 0,
  Codec: "MP3",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function mockAPI() {
  return {
    search: vi.fn<MetadataMatchAPI["search"]>(async () => [option]),
    loadResources: vi.fn<MetadataMatchResourceLoader>(async () => resources),
  };
}

describe("LocalMetadataMatch", () => {
  it("searches without MD5, requires manual selection and fences duplicate requests", async () => {
    const gate = deferred<MetadataMatchCandidate[]>();
    const api = mockAPI();
    api.search.mockReturnValueOnce(gate.promise);
    const scope = new LocalMetadataMatch(api, () => true, api.loadResources);
    const pending = scope.search(info, "a");
    expect(scope.busy).toBe(true);
    expect(await scope.search(info, "a")).toBeUndefined();
    expect(api.search).toHaveBeenCalledExactlyOnceWith(
      { title: "local", artist: "one / two", platform: "a" },
      expect.any(AbortSignal),
    );
    gate.resolve([option]);
    expect(await pending).toEqual([option]);
    expect(api.loadResources).not.toHaveBeenCalled();
    expect(await scope.choose({ id: "missing", platform: "a" })).toBeUndefined();
    expect(await scope.choose(option)).toEqual(draft);
    expect(await scope.choose(option)).toBeUndefined();
  });

  it("retains string IDs and distinguishes the same ID on different platforms", async () => {
    const api = mockAPI();
    const other = { ...option, platform: "b" };
    api.search.mockResolvedValueOnce([option, other]);
    const scope = new LocalMetadataMatch(api, () => true, api.loadResources);
    await scope.search(info, "a");
    await scope.choose(other);
    expect(api.loadResources).toHaveBeenCalledWith(other, expect.any(AbortSignal));
    expect(api.loadResources.mock.calls[0][0].id).toBe("90071992547409931");
  });

  it("aborts search on platform switch and discards its late response", async () => {
    const gate = deferred<MetadataMatchCandidate[]>();
    const api = mockAPI();
    api.search.mockReturnValueOnce(gate.promise);
    const scope = new LocalMetadataMatch(api, () => true, api.loadResources);
    const pending = scope.search(info, "a");
    scope.cancel();
    expect(api.search.mock.calls[0][1].aborted).toBe(true);
    const other = { ...option, id: "song:alpha", platform: "b" };
    api.search.mockResolvedValueOnce([other]);
    expect(await scope.search(info, "b")).toEqual([other]);
    gate.resolve([option]);
    expect(await pending).toBeUndefined();
    expect(await scope.choose(option)).toBeUndefined();
    await scope.choose(other);
    expect(api.loadResources).toHaveBeenCalledWith(other, expect.any(AbortSignal));
  });

  it("drops stale resource replies and aborts resources on cancel", async () => {
    let current = true;
    const gate = deferred<MetadataMatchResources>();
    const api = mockAPI();
    api.loadResources.mockReturnValueOnce(gate.promise);
    const scope = new LocalMetadataMatch(api, () => current, api.loadResources);
    await scope.search(info, "a");
    const pending = scope.choose(option);
    current = false;
    scope.cancel();
    expect(api.loadResources.mock.calls[0][1].aborted).toBe(true);
    gate.resolve(resources);
    expect(await pending).toBeUndefined();
  });

  it("reports live failures, releases busy and permits retry", async () => {
    const api = mockAPI();
    api.search.mockRejectedValueOnce(new Error("offline"));
    const scope = new LocalMetadataMatch(api, () => true, api.loadResources);
    await expect(scope.search(info, "")).rejects.toThrow("platform or title");
    expect(api.search).not.toHaveBeenCalled();
    await expect(scope.search(info, "a")).rejects.toThrow("offline");
    expect(scope.busy).toBe(false);
    api.search.mockResolvedValueOnce([]);
    expect(await scope.search(info, "a")).toEqual([]);
  });
});

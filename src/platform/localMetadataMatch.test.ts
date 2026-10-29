import { describe, expect, it, vi } from "vitest";
import {
  LocalMetadataMatch,
  type MetadataMatchCandidate,
  type MetadataMatchDraft,
} from "./localMetadataMatch";
import type { Info } from "./mygo.bindings";

const option: MetadataMatchCandidate = {
  id: 1,
  title: "matched",
  artists: ["artist"],
  album: "album",
  comment: "alias",
  cover: "",
};
const draft: MetadataMatchDraft = { ...option, lyrics: "lyric" };
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

describe("LocalMetadataMatch", () => {
  it("sends the real digest contract, requires selection, and fences duplicate requests", async () => {
    const gate = deferred<MetadataMatchCandidate[]>();
    const api = { search: vi.fn(() => gate.promise), details: vi.fn(async () => draft) };
    const scope = new LocalMetadataMatch(api, () => true);
    const pending = scope.search(info, "a".repeat(32));
    expect(scope.busy).toBe(true);
    expect(await scope.search(info, "a".repeat(32))).toBeUndefined();
    expect(api.search).toHaveBeenCalledExactlyOnceWith({
      title: "local",
      artist: "one / two",
      album: "local album",
      duration: 12.5,
      md5: "a".repeat(32),
    });
    gate.resolve([option]);
    expect(await pending).toEqual([option]);
    expect(api.details).not.toHaveBeenCalled();
    expect(await scope.choose(999)).toBeUndefined();
    expect(await scope.choose(1)).toEqual(draft);
    expect(await scope.choose(1)).toBeUndefined();
  });

  it("cancel discards pending search and prevents selection", async () => {
    const gate = deferred<MetadataMatchCandidate[]>();
    const api = { search: vi.fn(() => gate.promise), details: vi.fn(async () => draft) };
    const scope = new LocalMetadataMatch(api, () => true);
    const pending = scope.search(info, "a".repeat(32));
    scope.cancel();
    gate.resolve([option]);
    expect(await pending).toBeUndefined();
    expect(await scope.choose(1)).toBeUndefined();
    expect(api.details).not.toHaveBeenCalled();
  });

  it("drops stale detail replies and aborts resources on cancel", async () => {
    let current = true;
    const gate = deferred<MetadataMatchDraft>();
    const api = {
      search: vi.fn(async () => [option]),
      details: vi.fn<
        (candidate: MetadataMatchCandidate, signal: AbortSignal) => Promise<MetadataMatchDraft>
      >(() => gate.promise),
    };
    const scope = new LocalMetadataMatch(api, () => current);
    await scope.search(info, "a".repeat(32));
    const pending = scope.choose(1);
    current = false;
    scope.cancel();
    expect(api.details.mock.calls[0]?.[1]?.aborted).toBe(true);
    gate.resolve(draft);
    expect(await pending).toBeUndefined();
  });

  it("reports live failures, releases busy and permits retry without fabricating digest", async () => {
    const api = {
      search: vi.fn(async (): Promise<MetadataMatchCandidate[]> => {
        throw new Error("offline");
      }),
      details: vi.fn(async () => draft),
    };
    const scope = new LocalMetadataMatch(api, () => true);
    await expect(scope.search(info, "")).rejects.toThrow("native match digest");
    expect(api.search).not.toHaveBeenCalled();
    await expect(scope.search(info, "a".repeat(32))).rejects.toThrow("offline");
    expect(scope.busy).toBe(false);
    api.search.mockResolvedValueOnce([]);
    expect(await scope.search(info, "a".repeat(32))).toEqual([]);
  });
});

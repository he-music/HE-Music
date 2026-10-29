import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMetadataMatchAPI } from "./localMetadataMatchAPI";

const mocks = vi.hoisted(() => ({ search: vi.fn(), lyric: vi.fn(), artwork: vi.fn() }));
vi.mock("@/api/song", () => ({ matchSong: mocks.search, neteaseSongLyric: mocks.lyric }));
vi.mock("@/utils/lyric", () => ({ transSeparator: "translation", romaSeparator: "romanization" }));
vi.mock("./systemMediaArtwork", () => ({ loadSystemMediaArtwork: mocks.artwork }));
const settings = { downloadLyric: true, downloadLyricTran: true, downloadLyricRoma: true };
const query = {
  title: "local",
  artist: "one / two",
  album: "album",
  duration: 1.5,
  md5: "a".repeat(32),
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("window", { __HE_MUSIC_GATEWAY_ORIGIN__: "http://127.0.0.1:4444/session" });
});
afterEach(() => vi.unstubAllGlobals());

it("uses existing positional API contract and normalizes multiple selectable options", async () => {
  mocks.search.mockResolvedValue({
    result: {
      songs: [
        {
          id: 1,
          name: "first",
          ar: [{ name: "artist" }],
          al: { name: "album", picUrl: "https://example.test/cover.png" },
          alia: ["alias"],
        },
        { id: 2, name: "second", artists: "solo", album: "other" },
        { id: 1, name: "duplicate" },
        { id: "bad", name: "bad" },
      ],
    },
  });
  const api = createMetadataMatchAPI(() => settings);
  const options = await api.search(query);
  expect(mocks.search).toHaveBeenCalledExactlyOnceWith(
    "local",
    "one / two",
    "album",
    1.5,
    "a".repeat(32),
  );
  expect(options.map((item) => item.id)).toEqual([1, 2]);
  expect(options[0]).toEqual({
    id: 1,
    title: "first",
    artists: ["artist"],
    album: "album",
    comment: "alias",
    cover: "https://example.test/cover.png",
  });
  expect(mocks.lyric).not.toHaveBeenCalled();
  expect(mocks.artwork).not.toHaveBeenCalled();
});

it("loads chosen lyrics and artwork through existing budgeted loader", async () => {
  mocks.lyric.mockResolvedValue({
    lrc: { lyric: "original" },
    tlyric: { lyric: "translated" },
    romalrc: { lyric: "romanized" },
  });
  mocks.artwork.mockResolvedValue(btoa("\x89PNGfixture"));
  const signal = new AbortController().signal;
  const draft = await createMetadataMatchAPI(() => settings).details(
    {
      id: 2,
      title: "chosen",
      artists: ["a"],
      album: "album",
      comment: "alias",
      cover: "https://example.test/cover.png",
    },
    signal,
  );
  expect(mocks.lyric).toHaveBeenCalledExactlyOnceWith(2);
  expect(mocks.artwork).toHaveBeenCalledExactlyOnceWith("https://example.test/cover.png", signal);
  expect(draft.lyrics).toBe("original\n\ntranslation\ntranslated\n\nromanization\nromanized");
  expect(draft.picture).toEqual({
    MIME: "image/png",
    Type: 3,
    Description: "",
    Data: btoa("\x89PNGfixture"),
  });
});

it("rejects local paths and cancels before artwork acquisition", async () => {
  mocks.lyric.mockResolvedValue({ lrc: { lyric: "original" } });
  const api = createMetadataMatchAPI(() => settings);
  const option = {
    id: 2,
    title: "chosen",
    artists: [],
    album: "",
    comment: "",
    cover: "file:///private/music/cover.jpg",
  };
  await expect(api.details(option, new AbortController().signal)).rejects.toThrow(
    "Unsupported match artwork",
  );
  const controller = new AbortController();
  controller.abort();
  await expect(
    api.details({ ...option, cover: "https://example.test/cover.png" }, controller.signal),
  ).rejects.toThrow("cancelled");
  expect(mocks.artwork).not.toHaveBeenCalled();
});

it("retains existing original-lyric behavior when optional translated lyrics are disabled", async () => {
  mocks.lyric.mockResolvedValue({ lrc: { lyric: "original" }, tlyric: { lyric: "translated" } });
  const result = await createMetadataMatchAPI(() => ({
    ...settings,
    downloadLyric: false,
  })).details(
    { id: 1, title: "chosen", artists: [], album: "", comment: "", cover: "" },
    new AbortController().signal,
  );
  expect(result.lyrics).toBe("original");
  expect(result.picture).toBeUndefined();
});

it("rejects loopback artwork instead of bypassing the controlled gateway", async () => {
  mocks.lyric.mockResolvedValue({ lrc: { lyric: "original" } });
  await expect(
    createMetadataMatchAPI(() => settings).details(
      {
        id: 1,
        title: "chosen",
        artists: [],
        album: "",
        comment: "",
        cover: "http://127.0.0.1:8888/private",
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow("controlled gateway");
  expect(mocks.artwork).not.toHaveBeenCalled();
});

it.each([
  [
    "http://covers.fixture.invalid/cover.jpg",
    "https://covers.fixture.invalid/cover.jpg?param=1024y1024",
  ],
  [
    "https://covers.fixture.invalid/cover?thumbnail=300y300&",
    "https://covers.fixture.invalid/cover?thumbnail=1024y1024&",
  ],
  ["https://covers.fixture.invalid/cover.png", "https://covers.fixture.invalid/cover.png"],
])("uses legacy coverSize.l transformation for %s", async (source, expected) => {
  mocks.lyric.mockResolvedValue({ lrc: { lyric: "original" } });
  mocks.artwork.mockResolvedValue(btoa("\x89PNGfixture"));
  const signal = new AbortController().signal;
  await createMetadataMatchAPI(() => settings).details(
    { id: 1, title: "chosen", artists: [], album: "", comment: "", cover: source },
    signal,
  );
  expect(mocks.artwork).toHaveBeenCalledExactlyOnceWith(expected, signal);
});

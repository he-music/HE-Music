import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMetadataMatchAPI } from "./localMetadataMatchAPI";
import type { SongInfo } from "@/types/main.hemusic";

const request = vi.hoisted(() => vi.fn());
vi.mock("@/utils/request", () => ({ requestHemusic: request }));
const query = { title: "local", artist: "one / two", platform: "a" };
const signal = () => new AbortController().signal;
const song = (overrides: Partial<SongInfo> = {}): SongInfo => ({
  id: "song:alpha",
  platform: "a",
  name: "chosen",
  subtitle: "",
  artists: "one / two",
  album: "album",
  cover: "",
  duration: 1,
  mv_id: "",
  links: [],
  ...overrides,
});

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.unstubAllGlobals());

it("only exposes search, preserving strings and cross-platform candidate identity", async () => {
  request.mockResolvedValueOnce({
    list: [
      {
        song: song({
          id: "90071992547409931",
          artists: [{ id: "artist", name: "solo" }],
          album: { id: "album", name: "record" },
          alias: "alias",
        }),
      },
      { song: song({ id: "90071992547409931" }) },
      { song: song({ id: "90071992547409931", platform: "b" }) },
      { song: song() },
      { song: song({ id: "" }) },
      { song: song({ name: "" }) },
    ],
  });
  const api = createMetadataMatchAPI();
  const abort = signal();
  const options = await api.search(query, abort);
  expect(Object.keys(api)).toEqual(["search"]);
  expect(request).toHaveBeenCalledExactlyOnceWith({
    url: "/v1/song/search",
    params: { key: "local one / two", page_size: 10, page_index: 1, platform: "a" },
    signal: abort,
    skipErrorMessage: true,
  });
  expect(options.map(({ id, platform }) => [id, platform])).toEqual([
    ["90071992547409931", "a"],
    ["90071992547409931", "b"],
    ["song:alpha", "a"],
  ]);
  expect(options[0]).toMatchObject({ artists: ["solo"], album: "record", comment: "alias" });
  expect(options[2].artists).toEqual(["one / two"]);
});

it("limits candidates and handles empty search without selecting anything", async () => {
  const api = createMetadataMatchAPI();
  request.mockResolvedValueOnce({ list: [] });
  expect(await api.search(query, signal())).toEqual([]);
  request.mockResolvedValueOnce({
    list: Array.from({ length: 25 }, (_, index) => ({ song: song({ id: String(index) }) })),
  });
  expect(await api.search(query, signal())).toHaveLength(10);
  expect(await api.search({ ...query, title: "", artist: "" }, signal())).toEqual([]);
});

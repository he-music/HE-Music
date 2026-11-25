import axios from "axios";
import { expect, it, vi } from "vitest";
import { getLyricCandidate, searchLyricCandidates } from "./lyrics";

const request = vi.hoisted(() => vi.fn());
vi.mock("@/utils/request", () => ({ requestHemusic: request }));

it("搜索歌词以独立参数传每位歌手，不使用搜歌端点", async () => {
  const signal = new AbortController().signal;
  const candidate = { id: "12-x", name: "合唱", platform: "kugou" };
  request.mockResolvedValueOnce({ list: [candidate, { ...candidate, platform: "qq" }, candidate] });
  await expect(
    searchLyricCandidates(
      {
        platform: "kugou",
        name: "合唱",
        artist_names: ["歌手甲", "歌手乙"],
        duration: 23,
      },
      signal,
    ),
  ).resolves.toEqual([candidate]);
  const config = request.mock.lastCall?.[0];
  expect(config).toMatchObject({ url: "/v1/lyric/search", signal });
  const url = new URL(axios.getUri(config), "http://localhost");
  expect(url.searchParams.getAll("artist_names")).toEqual(["歌手甲", "歌手乙"]);
  expect(url.searchParams.get("duration")).toBe("23");
});

it("解析歌词详情的 info 包装并拒绝错误候选身份", async () => {
  const signal = new AbortController().signal;
  const candidate = { platform: "kugou", id: "12-x" };
  request.mockResolvedValueOnce({ info: { ...candidate, lyric: "[00:00.00]原文", trans: "译文" } });
  await expect(getLyricCandidate(candidate, signal)).resolves.toEqual({
    ...candidate,
    lyric: "[00:00.00]原文",
    trans: "译文",
    roma: "",
  });
  expect(request).toHaveBeenLastCalledWith(
    expect.objectContaining({
      url: "/v1/lyric",
      params: candidate,
      signal,
    }),
  );
  request.mockResolvedValueOnce({ info: { ...candidate, id: "other", lyric: "原文" } });
  await expect(getLyricCandidate(candidate, signal)).rejects.toThrow();
});

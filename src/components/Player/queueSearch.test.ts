import { describe, expect, it } from "vitest";
import { filterQueueSongs, normalizeQueueSearch } from "./queueSearch";

const songs = [
  { name: "Evening Song", artists: "Side A", queueIndex: 0 },
  {
    name: "海边",
    artists: [
      { id: "a", name: "林" },
      { id: "b", name: "Side B" },
    ],
    queueIndex: 1,
  },
  { name: "Interlude", queueIndex: 2 },
  { name: "Evening Song", artists: "Side A", queueIndex: 3 },
];

describe("播放队列搜索", () => {
  it("空白查询直接复用原队列", () => {
    expect(filterQueueSongs(songs, normalizeQueueSearch(" 　	"))).toBe(songs);
  });

  it("忽略大小写、全半角和多余空白，保留原顺序与同名曲目的位置", () => {
    const matches = filterQueueSongs(songs, normalizeQueueSearch(" ＥＶＥＮＩＮＧ　 Ａ"));
    expect(matches).toEqual([songs[0], songs[3]]);
    expect(matches[0]).toBe(songs[0]);
    expect(songs.map(({ queueIndex }) => queueIndex)).toEqual([0, 1, 2, 3]);
  });

  it("允许同时按歌曲标题和多位歌手匹配", () => {
    expect(filterQueueSongs(songs, normalizeQueueSearch("Side 林 海边"))).toEqual([songs[1]]);
  });

  it("没有歌手也能按歌名搜索，不匹配时返回空列表", () => {
    expect(filterQueueSongs(songs, normalizeQueueSearch("interlude"))).toEqual([songs[2]]);
    expect(filterQueueSongs(songs, normalizeQueueSearch("interlude side"))).toEqual([]);
  });
});

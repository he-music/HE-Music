import { describe, expect, it } from "vitest";
import type { SongInfo } from "@/types/main.hemusic";
import { groupSongs, splitArtistNames } from "./songGroup";

function song(id: string, platform = "local"): SongInfo {
  return {
    id,
    platform,
    name: id,
    subtitle: "",
    duration: 0,
    mv_id: "",
    album: "album",
    artists: "artist",
    links: [],
    cover: "",
  };
}

describe("groupSongs", () => {
  it("支持对象原型名称、数字名称并按名称排序", () => {
    const songs = ["constructor", "__proto__", "10", "2"].map((songName) => ({
      ...song(songName),
      album: songName,
    }));
    const groups = groupSongs(songs, (item) => [String(item.album)]);
    expect([...groups.keys()]).toEqual(["__proto__", "10", "2", "constructor"]);
    for (const item of songs) expect(groups.get(String(item.album))).toEqual([item]);
  });

  it("同一组内去重，保留不同平台的同 ID 歌曲以及原始歌曲引用", () => {
    const first = song("1");
    const other = song("1", "online");
    const groups = groupSongs([first, { ...first }, other], () => ["A", "A", "B"]);
    expect(groups.get("A")).toEqual([first, other]);
    expect(groups.get("B")).toEqual([first, other]);
    expect(groups.get("A")?.[0]).toBe(first);
  });

  it("支持空数据和空分组名", () => {
    expect(groupSongs([], () => [])).toEqual(new Map());
    const item = song("1");
    expect(groupSongs([item], () => [""]).get("")).toEqual([item]);
  });
});

describe("splitArtistNames", () => {
  it("顺序处理多个字面分隔符、去重、过滤空白", () => {
    expect(splitArtistNames(" A / B & C / A && ", ["/", "&", ""])).toEqual(["A", "B", "C"]);
    expect(splitArtistNames("A.B+C", [".", "+"])).toEqual(["A", "B", "C"]);
  });

  it("结构化歌手名称不再分割", () => {
    expect(splitArtistNames([{ id: "1", name: "AC/DC" }], ["/"])).toEqual(["AC/DC"]);
    expect(splitArtistNames(undefined, ["/"])).toEqual([]);
  });
});

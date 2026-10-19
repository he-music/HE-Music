import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope, ref } from "vue";
import type { SongInfo } from "@/types/main.hemusic";
import { useSongSearch } from "./useSongSearch";

function song(id: string, name: string): SongInfo {
  return {
    id,
    name,
    platform: "local",
    subtitle: "",
    duration: 0,
    mv_id: "",
    album: "专辑",
    artists: [{ id: "artist", name: "歌手" }],
    links: [],
    cover: "",
  };
}

describe("useSongSearch", () => {
  const scopes: ReturnType<typeof effectScope>[] = [];
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    scopes.forEach((scope) => scope.stop());
    scopes.length = 0;
    vi.useRealTimers();
  });

  function setup() {
    const songs = ref([song("1", "苹果"), song("2", "香蕉")]);
    const keyword = ref("");
    const source = vi.fn(() => songs.value);
    const scope = effectScope();
    scopes.push(scope);
    const results = scope.run(() => useSongSearch(source, keyword))!;
    return { songs, keyword, source, results };
  }

  it("关键词变化复用索引，清空输入立即清空结果", async () => {
    const { keyword, results, source } = setup();
    expect(results.value).toEqual([]);
    expect(source).not.toHaveBeenCalled();
    keyword.value = "苹果";
    await vi.advanceTimersByTimeAsync(300);
    expect(results.value.map((item) => item.id)).toEqual(["1"]);
    keyword.value = "香蕉";
    await vi.advanceTimersByTimeAsync(300);
    expect(results.value.map((item) => item.id)).toEqual(["2"]);
    expect(source).toHaveBeenCalledTimes(1);
    keyword.value = " ";
    expect(results.value).toEqual([]);
  });

  it("数据替换、追加和可搜索字段编辑后重新索引，封面变化不重建索引", async () => {
    const { songs, keyword, results, source } = setup();
    keyword.value = "苹果";
    await vi.advanceTimersByTimeAsync(300);
    expect(results.value.map((item) => item.id)).toEqual(["1"]);
    songs.value[0].cover = "new-cover";
    expect(results.value.map((item) => item.id)).toEqual(["1"]);
    expect(source).toHaveBeenCalledTimes(1);
    songs.value[0].name = "西瓜";
    expect(results.value).toEqual([]);
    songs.value.push(song("3", "苹果"));
    expect(results.value.map((item) => item.id)).toEqual(["3"]);
    songs.value = [song("4", "苹果")];
    expect(results.value.map((item) => item.id)).toEqual(["4"]);
    expect(source).toHaveBeenCalledTimes(4);
  });

  it("保留歌手和专辑字段的搜索能力", async () => {
    const { songs, keyword, results } = setup();
    songs.value[0].artists = "独特歌手";
    keyword.value = "独特歌手";
    await vi.advanceTimersByTimeAsync(300);
    expect(results.value.map((item) => item.id)).toEqual(["1"]);
    songs.value[1].album = { id: "album", name: "独特专辑" };
    keyword.value = "独特专辑";
    await vi.advanceTimersByTimeAsync(300);
    expect(results.value.map((item) => item.id)).toEqual(["2"]);
  });
});

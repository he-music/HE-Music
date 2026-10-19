import { computed, toRef, toValue, type MaybeRefOrGetter } from "vue";
import { refDebounced } from "@vueuse/core";
import Fuse from "fuse.js";
import type { SongInfo } from "@/types/main.hemusic";

/** 索引按歌曲数据缓存，关键词变化只执行查询；数据更新后自动重新查询。 */
export function useSongSearch(
  songs: MaybeRefOrGetter<readonly SongInfo[]>,
  keyword: MaybeRefOrGetter<string>,
) {
  const debouncedKeyword = refDebounced(
    toRef(() => toValue(keyword).trim()),
    300,
  );
  const index = computed(() => {
    return new Fuse(toValue(songs), {
      keys: [
        { name: "name", weight: 0.5 },
        { name: "id", weight: 0.2 },
        { name: "artists", weight: 0.15 },
        { name: "artists.name", weight: 0.15 },
        { name: "album", weight: 0.1 },
        { name: "album.name", weight: 0.1 },
      ],
      threshold: 0.35,
      ignoreLocation: true,
    });
  });

  return computed(() => {
    if (!toValue(keyword).trim() || !debouncedKeyword.value) return [];
    return index.value.search(debouncedKeyword.value).map((result) => result.item);
  });
}

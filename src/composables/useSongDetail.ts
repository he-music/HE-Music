import { computed, shallowRef, watch, type Ref } from "vue";
import { songDetail } from "@/api/song";
import type { GetSongDetailResponse } from "@/types/main.hemusic";

/** 一次请求加载全部详情，切歌或离开页面后忽略在途响应。 */
export function useSongDetail(
  songId: Ref<string>,
  platform: Ref<string>,
  enabled: Ref<boolean>,
  onError: (error: unknown) => void,
) {
  const detail = shallowRef<GetSongDetailResponse | null>(null);
  const song = computed(() => detail.value?.song ?? null);
  const fields = computed(() => detail.value?.fields ?? []);
  const sections = computed(() =>
    (detail.value?.sections ?? []).filter((section) => {
      switch (section.resource_type) {
        case "song":
          return !!section.songs?.length;
        case "album":
          return !!section.albums?.length;
        case "mv":
          return !!section.mvs?.length;
        case "playlist":
          return !!section.playlists?.length;
        default:
          return false;
      }
    }),
  );

  watch(
    [songId, platform, enabled],
    async ([id, source, activePage], _previous, onCleanup) => {
      let active = true;
      onCleanup(() => {
        active = false;
      });
      detail.value = null;
      if (!activePage || !id || !source) return;

      try {
        const response = await songDetail(id, source);
        if (active) detail.value = response;
      } catch (error) {
        if (active) onError(error);
      }
    },
    { immediate: true },
  );

  return { song, fields, sections };
}

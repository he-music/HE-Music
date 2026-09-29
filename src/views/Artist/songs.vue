<template>
  <AsyncContent
    class="artist-songs"
    :failed="failed"
    :loading="loading"
    :has-data="!!songData.length"
    @retry="retry"
  >
    <SongList
      :data="songData"
      :loading="loading"
      :load-more="hasMore && !failed"
      :show-footer="!failed"
      @reach-bottom="loadMore"
      @scroll="emit('scroll', $event)"
    />
  </AsyncContent>
</template>

<script setup lang="ts">
import { artistAllSongs } from "@/api/artist";
import { debounce } from "lodash-es";
import { usePlayer } from "@/utils/player";
import SongList from "@/components/List/SongList.vue";
import AsyncContent from "@/components/Page/AsyncContent.vue";
import { usePagedRequest } from "@/composables/usePagedRequest";
import type { SongInfo } from "@/types/main.hemusic";

const props = defineProps<{ id: string; platform: string }>();
const emit = defineEmits<{ scroll: [e: Event] }>();
const player = usePlayer();
const {
  data: songData,
  loading,
  failed,
  hasMore,
  loadMore,
  retry,
  reset,
} = usePagedRequest<SongInfo>((page) => artistAllSongs(props.id, props.platform, page, 50));
const playAllSongs = debounce(() => {
  if (songData.value.length) player.updatePlayList(songData.value);
}, 300);
defineExpose({ playAllSongs });
watch(() => [props.id, props.platform], reset, { immediate: true });
</script>

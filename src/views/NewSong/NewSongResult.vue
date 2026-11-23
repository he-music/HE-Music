<template>
  <AsyncContent
    class="new-song-result"
    :failed="failed"
    :loading="loading"
    :has-data="!!data.length"
    @retry="retry"
  >
    <div ref="listViewport" class="list-viewport">
      <NewSongSkeleton v-if="loading && !data.length" />
      <SongList
        v-else
        :data="data"
        :loading="loading"
        :load-more="hasMore && !failed"
        :show-footer="!failed"
        disabled-sort
        :height="songListHeight"
        @reach-bottom="loadMore"
      />
    </div>
  </AsyncContent>
</template>

<script setup lang="ts">
import { newSongs } from "@/api/song";
import SongList from "@/components/List/SongList.vue";
import type { SongInfo } from "@/types/main.hemusic";
import AsyncContent from "@/components/Page/AsyncContent.vue";
import { usePagedRequest } from "@/composables/usePagedRequest";
import NewSongSkeleton from "./NewSongSkeleton.vue";

const props = defineProps<{ tab_id: string; platform: string }>();
const listViewport = useTemplateRef<HTMLElement>("listViewport");
const { height: resultHeight } = useElementSize(listViewport);
const { data, loading, failed, hasMore, loadMore, retry, reset } = usePagedRequest<SongInfo>(
  (page) => newSongs(props.platform, props.tab_id, page),
);
const songListHeight = computed(() => Math.max(1, resultHeight.value));
watch(() => [props.tab_id, props.platform], reset, { immediate: true });
</script>

<style scoped>
.new-song-result {
  display: flex;
  flex-direction: column;
}

.new-song-result,
.list-viewport {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
</style>

<template>
  <AsyncContent
    class="search-type"
    :failed="failed"
    :loading="loading"
    :has-data="!!data.length"
    @retry="retry"
  >
    <SongList
      :data="data"
      :loading="loading"
      :load-more="hasMore && !failed"
      :show-footer="!failed"
      disabled-sort
      :height="songListHeight"
      @reach-bottom="loadMore"
    />
  </AsyncContent>
</template>

<script setup lang="ts">
import { newSongs } from "@/api/song";
import SongList from "@/components/List/SongList.vue";
import { useStatusStore } from "@/stores";
import type { SongInfo } from "@/types/main.hemusic";
import AsyncContent from "@/components/Page/AsyncContent.vue";
import { usePagedRequest } from "@/composables/usePagedRequest";

const props = defineProps<{ tab_id: string; platform: string }>();
const statusStore = useStatusStore();
const { data, loading, failed, hasMore, loadMore, retry, reset } = usePagedRequest<SongInfo>(
  (page) => newSongs(props.platform, props.tab_id, page),
);
const songListHeight = computed(() => statusStore.mainContentHeight - 50);
watch(() => [props.tab_id, props.platform], reset, { immediate: true });
</script>

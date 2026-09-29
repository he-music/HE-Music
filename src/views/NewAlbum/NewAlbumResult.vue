<template>
  <AsyncContent
    class="search-type"
    :failed="failed"
    :loading="loading"
    :has-data="!!data.length"
    @retry="retry"
  >
    <AlbumList
      :data="data"
      :loading="loading"
      :load-more="hasMore && !failed"
      @load-more="loadMore"
    />
  </AsyncContent>
</template>

<script setup lang="ts">
import { newAlbums } from "@/api/album";
import type { AlbumInfo } from "@/types/main.hemusic";
import AlbumList from "@/components/List/AlbumList.vue";
import AsyncContent from "@/components/Page/AsyncContent.vue";
import { usePagedRequest } from "@/composables/usePagedRequest";

const props = defineProps<{ tab_id: string; platform: string }>();
const { data, loading, failed, hasMore, loadMore, retry, reset } = usePagedRequest<AlbumInfo>(
  (page) => newAlbums(props.platform, props.tab_id, page),
);
watch(() => [props.tab_id, props.platform], reset, { immediate: true });
</script>

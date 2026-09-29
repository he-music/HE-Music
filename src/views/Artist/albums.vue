<template>
  <AsyncContent
    class="artist-type"
    :failed="failed"
    :loading="loading"
    :has-data="!!data.length"
    @retry="retry"
  >
    <AlbumList
      :data="data"
      :loading="loading"
      :load-more="hasMore && !failed"
      type="album"
      @load-more="loadMore"
    />
  </AsyncContent>
</template>

<script setup lang="ts">
import { artistAlbums } from "@/api/artist";
import type { AlbumInfo } from "@/types/main.hemusic";
import AlbumList from "@/components/List/AlbumList.vue";
import AsyncContent from "@/components/Page/AsyncContent.vue";
import { usePagedRequest } from "@/composables/usePagedRequest";

const props = defineProps<{ id: string; platform: string }>();
const { data, loading, failed, hasMore, loadMore, retry, reset } = usePagedRequest<AlbumInfo>(
  (page) => artistAlbums(props.id, props.platform, page, 50),
);
watch(() => [props.id, props.platform], reset, { immediate: true });
</script>

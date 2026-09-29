<template>
  <AsyncContent
    class="artist-type"
    :failed="failed"
    :loading="loading"
    :has-data="!!data.length"
    @retry="retry"
  >
    <VideoList
      :data="data"
      :loading="loading"
      :load-more="hasMore && !failed"
      type="video"
      cols="2 600:2 800:3 900:4 1200:5 1400:6"
      @load-more="loadMore"
    />
  </AsyncContent>
</template>

<script setup lang="ts">
import { artistVideos } from "@/api/artist";
import type { MVInfo } from "@/types/main.hemusic";
import VideoList from "@/components/List/VideoList.vue";
import AsyncContent from "@/components/Page/AsyncContent.vue";
import { usePagedRequest } from "@/composables/usePagedRequest";

const props = defineProps<{ id: string; platform: string }>();
const { data, loading, failed, hasMore, loadMore, retry, reset } = usePagedRequest<MVInfo>((page) =>
  artistVideos(props.id, props.platform, page, 50),
);
watch(() => [props.id, props.platform], reset, { immediate: true });
</script>

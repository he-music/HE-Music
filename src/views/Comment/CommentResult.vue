<template>
  <AsyncContent :failed="failed" :loading="loading" :has-data="!!data.length" @retry="retry">
    <CommentList
      :data="data"
      :loading="loading"
      :load-more="hasMore && !failed"
      @load-more="loadMore"
      @load-sub-more="loadSubMore"
    />
  </AsyncContent>
</template>

<script setup lang="ts">
import AsyncContent from "@/components/Page/AsyncContent.vue";
import { useComments } from "@/composables/useComments";

const props = defineProps<{
  resource_type: "song" | "mv" | "album" | "playlist";
  platform: string;
  id: string;
  type: string;
}>();

const { data, loading, failed, hasMore, loadMore, retry, loadSubMore } = useComments(() => ({
  id: props.id,
  platform: props.platform,
  resourceType: props.resource_type,
  hot: props.type === "hot",
}));
</script>

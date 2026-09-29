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
import type { CommentInfo } from "@/types/main.hemusic";
import { getComment, getSubComment } from "@/api/comment";
import AsyncContent from "@/components/Page/AsyncContent.vue";
import { usePagedRequest } from "@/composables/usePagedRequest";

const props = defineProps<{
  resource_type: "song" | "mv" | "album" | "playlist";
  platform: string;
  id: string;
  type: string;
}>();

const { data, loading, failed, hasMore, loadMore, retry, reset } = usePagedRequest<CommentInfo>(
  async (page, cursor) => {
    const result = await getComment(
      props.id,
      props.platform,
      props.resource_type,
      page,
      20,
      cursor,
      props.type === "hot",
    );
    return {
      ...result,
      list: result.list.map((item: CommentInfo) =>
        reactive({
          ...item,
          sub_has_more: Number(item.reply_count) > item.sub_comments.length,
          sub_loading: false,
          sub_last_id: "",
          sub_page_index: 1,
        }),
      ),
    };
  },
);

const loadSubMore = async (item: CommentInfo) => {
  if (item.sub_loading) return;
  item.sub_loading = true;
  try {
    const result = await getSubComment(
      props.id,
      props.platform,
      item.id,
      props.resource_type,
      item.sub_page_index,
      15,
      item.sub_last_id,
    );
    item.sub_comments =
      item.sub_page_index === 1 ? result.list : item.sub_comments.concat(result.list);
    item.sub_has_more = result.has_more;
    item.sub_last_id = result.last_id;
    item.sub_page_index++;
  } catch {
    // The request layer reports the error; the existing button retries the same page.
  } finally {
    item.sub_loading = false;
  }
};
watch(() => [props.id, props.platform, props.resource_type, props.type], reset, {
  immediate: true,
});
</script>

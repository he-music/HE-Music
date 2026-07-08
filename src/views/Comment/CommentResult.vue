<template>
  <CommentList
    :data="commentData"
    :loading="commentLoading"
    :load-more="commentHasMore"
    @load-more="loadMoreComment"
    @load-sub-more="loadSubMore"
  />
</template>

<script setup lang="ts">
import { CommentInfo } from "@/types/main.hemusic";
import { getComment, getSubComment } from "@/api/comment";
import { useI18n } from "vue-i18n";

const { t } = useI18n();

const props = defineProps<{
  resource_type: "song" | "mv" | "album" | "playlist";
  platform: string;
  id: string;
  type: string;
}>();

// 评论数据
const commentLoading = ref<boolean>(true);
const commentData = ref<CommentInfo[]>([]);
const commentPage = ref<number>(1);
const commentHasMore = ref<boolean>(false);
const commentLastId = ref<string>("");
const commentTotalCount = ref<number>(0);

// 加载更多评论
const loadMoreComment = () => {
  commentPage.value++;
  if (commentHasMore.value) getCommentData(false);
};

const loadSubMore = async (item: CommentInfo) => {
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
    if (item.sub_page_index === 1) {
      item.sub_comments = result.list;
    } else {
      item.sub_comments = item.sub_comments.concat(result.list);
    }
    item.sub_has_more = result.has_more;
    item.sub_last_id = result.last_id;
    item.sub_page_index++;
  } finally {
    item.sub_loading = false;
  }
};

// 获取评论数据
const getCommentData = async (clean: boolean = true) => {
  try {
    if (!props.id || !props.platform) return;
    commentLoading.value = true;
    if (clean) {
      commentData.value = [];
      commentPage.value = 1;
    }
    // 获取评论
    const result = await getComment(
      props.id,
      props.platform,
      props.resource_type,
      commentPage.value,
      20,
      commentLastId.value,
      props.type === "hot",
    );

    for (let item of result.list) {
      item.sub_has_more = item.reply_count > 0 && item.reply_count > item.sub_comments.length;
      item.sub_loading = false;
      item.sub_last_id = "";
      item.sub_page_index = 1;
    }

    // 处理数据
    commentData.value = commentData.value.concat(result.list);
    // 是否还有
    commentHasMore.value = result.has_more;
    commentTotalCount.value = result.total_count;
    commentLastId.value = result.last_id;
    commentLoading.value = false;
  } catch (error) {
    console.error("Error getting comment data:", error);
    window.$message.error(t("message.get_comment_data_fail"));
  }
};

watch(
  () => [props.id, props.platform, props.resource_type],
  () => {
    getCommentData(true);
  },
);

onMounted(() => {
  getCommentData();
});
</script>

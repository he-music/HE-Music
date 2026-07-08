<!-- 播放器 - 评论 -->
<template>
  <div class="player-comment">
    <n-flex :wrap="false" align="center" class="song-data">
      <n-image
        :src="musicStore.songCover"
        :alt="musicStore.songCover"
        class="cover-img"
        preview-disabled
        @load="coverLoaded"
      >
        <template #placeholder>
          <div class="cover-loading">
            <img src="/images/song.jpg?asset" class="loading-img" alt="loading-img" />
          </div>
        </template>
      </n-image>
      <n-flex :size="2" class="song-info" vertical>
        <span class="title text-hidden">{{ musicStore.playSong.name }}</span>
        <span class="artist text-hidden">
          {{
            Array.isArray(musicStore.playSong.artists)
              ? musicStore.playSong.artists.map((item) => item.name).join(" / ")
              : String(musicStore.playSong.artists)
          }}
        </span>
      </n-flex>
      <n-flex
        class="close"
        align="center"
        justify="center"
        @click="statusStore.showPlayerComment = false"
      >
        <SvgIcon name="Music" :size="24" />
      </n-flex>
    </n-flex>
    <n-scrollbar ref="commentScroll" class="comment-scroll">
      <template v-if="commentHotData">
        <div class="placeholder">
          <div class="title">
            <SvgIcon name="Fire" />
            <span>
              {{ t("common.hot_comment") }}
            </span>
          </div>
        </div>
        <CommentList
          :data="commentHotData"
          :loading="commentHotData?.length === 0"
          transparent
          @load-sub-more="loadSubMore"
        />
      </template>
      <div class="placeholder">
        <div class="title">
          <SvgIcon name="Message" />
          <span>{{ t("common.all_comment") }}</span>
        </div>
      </div>
      <CommentList
        :data="commentData"
        :loading="commentLoading"
        type="song"
        :load-more="commentHasMore"
        transparent
        @load-more="loadMoreComment"
        @load-sub-more="loadSubMore"
      />
      <div class="placeholder" />
    </n-scrollbar>
  </div>
</template>

<script setup lang="ts">
import { useMusicStore, useStatusStore } from "@/stores";
import { getComment, getSubComment } from "@/api/comment";
import { isEmpty } from "lodash-es";
import type { CommentInfo } from "@/types/main.hemusic";
import { NScrollbar } from "naive-ui";
import { coverLoaded } from "@/utils/helper";
import { useI18n } from "vue-i18n";
const { t } = useI18n();

const musicStore = useMusicStore();
const statusStore = useStatusStore();

const commentScroll = ref<InstanceType<typeof NScrollbar> | null>(null);

// 是否展示
const isShowComment = computed<boolean>(() => statusStore.showPlayerComment);

// 歌曲 id
const songId = computed<string>(() => musicStore.playSong.id);
const songPlatform = computed<string>(() => musicStore.playSong.platform);

// 评论数据
const commentLoading = ref<boolean>(true);
const commentData = ref<CommentInfo[]>([]);
const commentHotData = ref<CommentInfo[] | null>([]);
const commentPage = ref<number>(1);
const commentHasMore = ref<boolean>(true);
const commentLastId = ref<string>("");

// 获取热门评论
const getHotCommentData = async () => {
  if (!songId.value || !songPlatform.value) return;
  // 获取评论
  const result = await getComment(songId.value, songPlatform.value, "song", 1, 20, "", true);

  for (let item of result.list) {
    item.sub_has_more = item.reply_count > item.sub_comments.length;
    item.sub_loading = false;
    item.sub_last_id = "";
    item.sub_page_index = 1;
  }

  commentHotData.value = result.list?.length > 0 ? result.list : null;
  // 滚动到顶部
  commentScroll.value?.scrollTo({ top: 0, behavior: "smooth" });
};

// 获取歌曲评论
const getAllComment = async () => {
  if (!songId.value || !songPlatform.value) return;
  commentLoading.value = true;
  // 获取评论
  const result = await getComment(
    songId.value,
    songPlatform.value,
    "song",
    commentPage.value,
    20,
    commentLastId.value,
  );
  if (isEmpty(result.list)) {
    commentHasMore.value = false;
    commentLoading.value = false;
    return;
  }

  for (let item of result.list) {
    item.sub_has_more = item.reply_count > item.sub_comments.length;
    item.sub_loading = false;
    item.sub_last_id = "";
    item.sub_page_index = 1;
  }

  commentData.value = commentData.value.concat(result.list);
  // 是否还有
  commentHasMore.value = result.has_more;
  commentLoading.value = false;
  commentLastId.value = result.last_id;
};

// 加载更多
const loadMoreComment = () => {
  commentPage.value += 1;
  getAllComment();
};

const loadSubMore = async (item: CommentInfo) => {
  item.sub_loading = true;
  try {
    const result = await getSubComment(
      songId.value,
      songPlatform.value,
      item.id,
      "song",
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

// 歌曲id变化
watch(
  () => songId.value,
  () => {
    commentData.value = [];
    commentHotData.value = [];
    commentPage.value = 1;
    commentHasMore.value = true;
    if (!isShowComment.value) return;
    getHotCommentData();
    getAllComment();
  },
);

// 是否展示
watch(
  () => isShowComment.value,
  (newVal) => {
    if (!newVal) return;
    // 若不存在数据，重新获取
    if (!commentData.value?.length) {
      getHotCommentData();
      getAllComment();
    }
  },
);

onMounted(() => {
  if (!isShowComment.value) return;
  getHotCommentData();
  getAllComment();
});
</script>

<style lang="scss" scoped>
.player-comment {
  position: absolute;
  right: 0;
  flex: 1;
  width: 100%;
  height: calc(100vh - 160px);
  overflow: hidden;
  :deep(.n-text),
  :deep(.n-icon),
  :deep(.n-button) {
    color: rgb(var(--main-cover-color)) !important;
  }
  .song-data {
    height: 90px;
    margin: 0 60px 12px;
    padding: 0 16px;
    border-radius: 12px;
    background-color: rgba(var(--main-cover-color), 0.08);
    .cover-img {
      width: 60px;
      height: 60px;
      border-radius: 12px;
      margin-right: 4px;
    }
    .title {
      font-size: 20px;
      font-weight: bold;
    }
    .artist {
      opacity: 0.8;
    }
    .close {
      width: 40px;
      height: 40px;
      margin-left: auto;
      background-color: rgba(var(--main-cover-color), 0.08);
      border-radius: 8px;
      transition: background-color 0.3s;
      cursor: pointer;
      &:hover {
        background-color: rgba(var(--main-cover-color), 0.29);
      }
    }
  }
  :deep(.comment-scroll) {
    height: calc(100vh - 262px);
    filter: drop-shadow(0px 4px 6px rgba(0, 0, 0, 0.2));
    mask: linear-gradient(
      180deg,
      hsla(0, 0%, 100%, 0) 0,
      hsla(0, 0%, 100%, 0.6) 2%,
      #fff 5%,
      #fff 90%,
      hsla(0, 0%, 100%, 0.6) 95%,
      hsla(0, 0%, 100%, 0)
    );
    .n-scrollbar-content {
      padding: 0 60px;
    }
    .n-skeleton {
      background: rgba(var(--main-cover-color), 0.08)
        linear-gradient(
          90deg,
          rgba(var(--main-cover-color), 0.08) 25%,
          rgba(var(--main-cover-color), 0.14) 37%,
          rgba(var(--main-cover-color), 0.08) 63%
        );
      background-size: 400% 100%;
    }
  }
  .comment-list {
    margin: 0 auto;
  }
  .placeholder {
    width: 100%;
    height: 100px;
    padding-bottom: 20px;
    display: flex;
    align-items: flex-end;
    &:last-child {
      height: 0;
      padding-top: 50%;
    }
    .title {
      display: flex;
      align-items: center;
      font-size: 22px;
      font-weight: bold;
      .n-icon {
        margin-right: 6px;
      }
    }
  }
}
</style>

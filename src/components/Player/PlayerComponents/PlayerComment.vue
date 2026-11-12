<!-- 播放器 - 评论 -->
<template>
  <div class="player-comment">
    <n-flex :wrap="false" align="center" class="song-data">
      <n-image
        :src="gatewayProxyUrl(musicStore.songCover)"
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
import { gatewayProxyUrl } from "@/platform/gateway";
import { useMusicStore, usePlatformStore, useStatusStore } from "@/stores";
import { FeatureSupportFlag } from "@/api/platform";
import { useComments } from "@/composables/useComments";
import { NScrollbar } from "naive-ui";
import { coverLoaded } from "@/utils/helper";
import { useI18n } from "vue-i18n";

const { t } = useI18n();
const musicStore = useMusicStore();
const statusStore = useStatusStore();
const platformStore = usePlatformStore();
const commentScroll = ref<InstanceType<typeof NScrollbar> | null>(null);
const isShowComment = computed(() => statusStore.showPlayerComment);
const songId = computed(() => musicStore.playSong.id);
const songPlatform = computed(() => musicStore.playSong.platform);
const identity = computed(() => JSON.stringify([songId.value, songPlatform.value]));
const requestedIdentity = ref("");

// 关闭后保留当前歌曲评论，隐藏期间切歌则等待再次打开。
watch(
  [isShowComment, songId, songPlatform],
  ([show]) => {
    if (show) requestedIdentity.value = identity.value;
  },
  { immediate: true, flush: "sync" },
);
const commentQuery = () => ({
  id: songId.value,
  platform: songPlatform.value,
  resourceType: "song" as const,
  enabled:
    requestedIdentity.value === identity.value &&
    platformStore.isFeatureSupport(songPlatform.value, FeatureSupportFlag.GetCommentList),
});
const {
  data: commentData,
  loading: commentLoading,
  hasMore: commentHasMore,
  retry: loadMoreComment,
  failed: commentFailed,
  loadSubMore,
} = useComments(commentQuery);
const hotComments = useComments(() => ({ ...commentQuery(), hot: true }));
const commentHotData = computed(() =>
  hotComments.loading.value ? [] : hotComments.data.value.length ? hotComments.data.value : null,
);

watch(isShowComment, (show) => {
  if (!show) return;
  if (commentFailed.value) void loadMoreComment();
  if (hotComments.failed.value) void hotComments.retry();
});
watch(hotComments.loading, (loading) => {
  if (!loading && isShowComment.value) {
    commentScroll.value?.scrollTo({ top: 0, behavior: "smooth" });
  }
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

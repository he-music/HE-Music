<!-- 视频 -->
<template>
  <div class="video">
    <div class="video-layout" :class="{ 'with-feed': canLoadFeeds }">
      <!-- 视频信息 -->
      <Transition name="fade" mode="out-in">
        <div v-if="videoData" class="info">
          <n-h2 class="name">
            <n-ellipsis :line-clamp="1" :tooltip="{ placement: 'bottom' }">
              {{ videoData.name || t("common.unknown_video") }}
            </n-ellipsis>
          </n-h2>
          <n-flex class="meta" align="center">
            <div class="item">
              <SvgIcon name="Video" :depth="3" />
              <n-text>{{ n(Number(videoData.play_count) || 0, "number") }}</n-text>
            </div>
            <!--          <div class="item">-->
            <!--            <SvgIcon name="Chat" :depth="3" />-->
            <!--            <n-text>{{ formatNumber(videoData.commentCount || 0) }}</n-text>-->
            <!--          </div>-->
            <!--          <div class="item">-->
            <!--            <SvgIcon name="Time" :depth="3" />-->
            <!--            <n-text>{{ formatTimestamp(videoData.updateTime || videoData.createTime) }}</n-text>-->
            <!--          </div>-->
          </n-flex>
        </div>
        <div v-else class="info">
          <n-skeleton :repeat="2" text round />
        </div>
      </Transition>
      <!-- 视频播放器 -->
      <div class="player">
        <div ref="playerHost" />
        <n-select
          v-if="hlsQualities.length"
          v-model:value="hlsQuality"
          class="hls-quality"
          size="small"
          :aria-label="t('common.quality')"
          :options="hlsQualityOptions"
          @update:value="playback?.setHlsQuality($event)"
        />
        <div v-if="videoLoading || videoFailed" class="player-state">
          <n-spin v-if="videoLoading" />
          <template v-else>
            <n-text>{{ t("message.get_video_data_fail") }}</n-text>
            <n-button @click="getVideoData(videoId, videoPlatform)">{{
              t("page_section.retry")
            }}</n-button>
          </template>
        </div>
      </div>
      <aside v-if="canLoadFeeds" class="feed-panel">
        <div class="feed-header">
          <n-h3>{{ t("video_feed.title") }}</n-h3>
          <n-text depth="3">{{ feedItems.length }}</n-text>
        </div>
        <div v-if="feedLoading && !feedItems.length" class="feed-loading">
          <n-skeleton v-for="item in 4" :key="item" height="64px" round />
        </div>
        <n-empty
          v-else-if="feedFailed && !feedItems.length"
          :description="t('page_section.load_failed')"
        >
          <template #extra>
            <n-button size="small" @click="loadMvFeeds()">{{ t("page_section.retry") }}</n-button>
          </template>
        </n-empty>
        <div v-else class="feed-list">
          <button
            v-for="item in feedItems"
            :key="`${item.platform}-${item.id}`"
            class="feed-item"
            :class="{ active: item.id === videoId && item.platform === videoPlatform }"
            type="button"
            @click="selectFeedItem(item)"
          >
            <s-image
              :src="item.cover"
              default-src="/images/video.jpg?asset"
              class="feed-cover"
              once
            />
            <span class="feed-item-content">
              <n-text class="feed-name" :depth="item.id === videoId ? 1 : 2">{{
                item.name
              }}</n-text>
              <n-text v-if="item.creator" class="feed-creator" depth="3">{{ item.creator }}</n-text>
            </span>
          </button>
          <n-button
            v-if="feedHasMore || feedLoading"
            class="feed-more"
            secondary
            strong
            :loading="feedLoading"
            @click="loadMvFeeds()"
          >
            {{ t("common.load_more") }}
          </n-button>
          <n-text v-if="feedFailed" class="feed-error" depth="3">
            {{ t("page_section.load_failed") }}
            <n-button text type="primary" @click="loadMvFeeds()">{{
              t("page_section.retry")
            }}</n-button>
          </n-text>
        </div>
      </aside>
      <!-- 菜单 -->
      <!--    <Transition name="fade" mode="out-in">-->
      <!--      <n-flex :key="videoData?.id" class="menu" justify="space-between" align="center">-->
      <!--        <n-flex class="control">-->
      <!--          &lt;!&ndash; 点赞 &ndash;&gt;-->
      <!--          <n-button :focusable="false" quaternary>-->
      <!--            <template #icon>-->
      <!--              <SvgIcon :name="videoData?.liked ? 'ThumbUp' : 'ThumbUpOff'" />-->
      <!--            </template>-->
      <!--            {{ formatNumber(videoData?.likedCount || 0) }}-->
      <!--          </n-button>-->
      <!--          &lt;!&ndash; 收藏 &ndash;&gt;-->
      <!--          <n-button :focusable="false" quaternary>-->
      <!--            <template #icon>-->
      <!--              <SvgIcon name="Favorite" />-->
      <!--              &lt;!&ndash; FavoriteBorder &ndash;&gt;-->
      <!--            </template>-->
      <!--            {{ formatNumber(videoData?.subCount || 0) }}-->
      <!--          </n-button>-->
      <!--          &lt;!&ndash; 分享 &ndash;&gt;-->
      <!--          <n-button :focusable="false" quaternary>-->
      <!--            <template #icon>-->
      <!--              <SvgIcon name="Share" />-->
      <!--              &lt;!&ndash; FavoriteBorder &ndash;&gt;-->
      <!--            </template>-->
      <!--            {{ formatNumber(videoData?.shareCount || 0) }}-->
      <!--          </n-button>-->
      <!--        </n-flex>-->
      <!--      </n-flex>-->
      <!--    </Transition>-->
      <!--     简介及标签-->
      <!-- 简介及标签 -->
      <Transition name="fade" mode="out-in">
        <div v-if="videoData" class="desc">
          <n-divider />
          <n-ellipsis :line-clamp="3" :tooltip="{ placement: 'bottom', width: 'trigger' }">
            {{ videoData?.description || t("common.no_description") }}
          </n-ellipsis>
          <!--          <n-flex v-if="videoData?.tags" class="tags">-->
          <!--            <n-tag v-for="(item, index) in videoData.tags" :key="index" :bordered="false" round>-->
          <!--              {{ item }}-->
          <!--            </n-tag>-->
          <!--          </n-flex>-->
          <n-divider />
        </div>
        <div v-else class="desc">
          <n-skeleton :repeat="3" text round />
        </div>
      </Transition>
      <!-- 评论 -->
      <div
        v-if="platformStore.isFeatureSupport(videoPlatform, FeatureSupportFlag.GetCommentList)"
        class="comment"
      >
        <n-flex class="title" justify="space-between">
          <n-h3 prefix="bar">
            {{ t("common.comment") }}
            <n-text v-if="commentTotalCount > 0" class="num" depth="3">
              {{ commentTotalCount }}
            </n-text>
          </n-h3>
          <n-flex class="tag">
            <n-tag
              v-for="(item, key, index) in commentText"
              :key="index"
              :bordered="false"
              :type="key === commentType ? 'primary' : 'default'"
              round
              @click="changeCommentType(key)"
            >
              {{ item }}
            </n-tag>
          </n-flex>
        </n-flex>
        <CommentList
          :data="commentData"
          :loading="commentLoading"
          :load-more="commentHasMore"
          @load-more="loadMoreComment"
          @load-sub-more="loadSubMore"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useDataStore, usePlatformStore, useStatusStore } from "@/stores";
import { getMVUrlStr, mvFeeds, videoDetail } from "@/api/video";
import { getComment, getSubComment } from "@/api/comment";
import { usePlayer } from "@/utils/player";
// Plyr
import type Plyr from "plyr";
import "plyr/dist/plyr.css";
import type { CommentInfo, MVInfo } from "@/types/main.hemusic";
import { FeatureSupportFlag } from "@/api/platform";
import { useI18n } from "vue-i18n";
import { useVideoFeed } from "@/composables/useVideoFeed";
import { createVideoPlayback } from "@/utils/videoPlayback";

const { t, n } = useI18n();

const player = usePlayer();
const router = useRouter();
const statusStore = useStatusStore();
const dataStore = useDataStore();
const platformStore = usePlatformStore();

// 视频参数
const videoId = computed<string>(() => router.currentRoute.value.query.id as string);
const videoPlatform = computed<string>(() => router.currentRoute.value.query.platform as string);

// 视频数据
const playerHost = ref<HTMLDivElement | null>(null);
const videoData = ref<MVInfo | null>(null);

// 评论数据
const commentLoading = ref<boolean>(true);
const commentData = ref<CommentInfo[]>([]);
const commentType = ref<"hot" | "new">("hot");
const commentPage = ref<number>(1);
const commentHasMore = ref<boolean>(true);
const commentText = computed(() => ({ hot: t("common.hottest"), new: t("common.newest") }));
const commentLastId = ref<string>("");
const commentTotalCount = ref<number>(0);

const canLoadFeeds = computed(() =>
  platformStore.isFeatureSupport(videoPlatform.value, FeatureSupportFlag.ListMVFeeds),
);
const {
  items: feedItems,
  loading: feedLoading,
  failed: feedFailed,
  hasMore: feedHasMore,
  loadMore: loadMvFeeds,
} = useVideoFeed(canLoadFeeds, videoData, mvFeeds);

const selectFeedItem = (item: MVInfo) => {
  if (item.id === videoId.value && item.platform === videoPlatform.value) return;
  router.push({ name: "video", query: { id: item.id, platform: item.platform } });
};

// 播放器配置
const playerOptions: Plyr.Options = {
  fullscreen: {
    enabled: true,
    fallback: true,
    iosNative: true,
  },
  controls: [
    "play-large",
    "play",
    "progress",
    "current-time",
    "mute",
    "volume",
    "captions",
    "settings",
    "airplay",
    "pip",
    "fullscreen",
  ],
  settings: ["captions", "quality", "speed"],
  ratio: "16:9",
  invertTime: false,
  autoplay: true,
  quality: {
    default: 1080,
    options: [4320, 2880, 2160, 1440, 1080, 720, 576, 480, 360, 240],
  },
  i18n: {
    play: t("common.play"),
    pause: t("common.pause"),
    speed: t("common.speed"),
    settings: t("common.setting"),
    normal: t("common.normal"),
    quality: t("common.quality"),
    pip: t("common.pip"),
    enterFullscreen: t("common.enter_fullscreen"),
    exitFullscreen: t("common.exit_fullscreen"),
    mute: t("common.mute"),
    unmute: t("common.unmute"),
  },
  tooltips: {
    controls: true,
  },
};

let playback: ReturnType<typeof createVideoPlayback> | undefined;
let videoRequest = 0;
const videoLoading = ref(false);
const videoFailed = ref(false);
const hlsQualities = ref<number[]>([]);
const hlsQuality = ref(-1);
const hlsQualityOptions = computed(() => [
  { label: t("common.auto"), value: -1 },
  ...hlsQualities.value.map((quality) => ({ label: `${quality}p`, value: quality })),
]);

const getVideoData = async (id: string, platform: string) => {
  if (!id || !platform || !playerHost.value) return;
  const request = ++videoRequest;
  playback?.pause();
  videoLoading.value = true;
  videoFailed.value = false;
  try {
    const result: MVInfo = await videoDetail(id, platform);
    if (request !== videoRequest) return;
    videoData.value = { ...result, id, platform };
    const sources = (result.links || []).map((item) => ({
      src: item.url || getMVUrlStr(platform, id, item.quality, item.format, true, dataStore.token),
      type: item.format === "hls" ? "application/x-mpegURL" : "video/mp4",
      size: item.quality,
    }));
    if (!sources.length) throw new Error("No video sources");
    playback ??= createVideoPlayback(
      playerHost.value,
      playerOptions,
      () => player.pause(),
      () => {
        videoFailed.value = true;
      },
      (qualities) => {
        hlsQualities.value = qualities;
        hlsQuality.value = -1;
      },
    );
    playback.setSource(sources, result.name, result.cover);
    if (platformStore.isFeatureSupport(platform, FeatureSupportFlag.GetCommentList)) {
      void getCommentData(id, platform);
    }
  } catch (error) {
    if (request !== videoRequest) return;
    videoFailed.value = true;
    console.error("Error getting video data:", error);
  } finally {
    if (request === videoRequest) videoLoading.value = false;
  }
};

// 获取评论数据
const getCommentData = async (id: string, platform: string, clean: boolean = true) => {
  try {
    if (!id || !platform) return;
    commentLoading.value = true;
    if (clean) {
      commentData.value = [];
      commentPage.value = 1;
    }
    // 获取评论
    const result = await getComment(
      id,
      videoPlatform.value,
      "mv",
      commentPage.value,
      20,
      commentLastId.value,
      commentType.value === "hot",
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

// 加载更多评论
const loadMoreComment = () => {
  commentPage.value++;
  if (commentHasMore.value) getCommentData(videoId.value, videoPlatform.value, false);
};

const loadSubMore = async (item: CommentInfo) => {
  item.sub_loading = true;
  try {
    const result = await getSubComment(
      videoId.value,
      videoPlatform.value,
      item.id,
      "mv",
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

// 关闭音乐播放
const closeMusic = (close: boolean = true) => {
  statusStore.showPlayBar = !close;
  if (close) player.pause();
};

const changeCommentType = (type: "hot" | "new") => {
  if (type === commentType.value) return;
  commentType.value = type;
  getCommentData(videoId.value, videoPlatform.value, true);
};

watch([videoId, videoPlatform], ([id, platform], previous) => {
  if (previous && (id !== previous[0] || platform !== previous[1])) {
    getVideoData(id, platform);
  }
});

onUnmounted(() => {
  closeMusic(false);
  videoRequest++;
  playback?.destroy();
});

onMounted(() => {
  closeMusic();
  // 获取视频数据
  getVideoData(videoId.value, videoPlatform.value);
});
</script>

<style lang="scss" scoped>
.video {
  min-width: 0;
  width: 100%;
  container-type: inline-size;
  --plyr-color-main: var(--primary-hex);
  --plyr-video-control-color-hover: var(--background-hex);
  --plyr-control-radius: 8px;
  .info {
    display: flex;
    flex-direction: column;
    justify-content: space-around;
    height: 60px;
    margin: 20px 0;
    .name {
      font-size: 28px;
      font-weight: bold;
      line-height: 30px;
      margin-bottom: 8px;
    }
    .meta {
      width: 100%;
      .item {
        display: flex;
        align-items: center;
        .n-icon {
          font-size: 18px;
          margin-right: 6px;
        }
      }
    }
  }
  .video-layout {
    display: grid;
    min-width: 0;
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas: "info" "player" "desc" "comment";
    grid-template-rows: auto auto auto 1fr;
    &.with-feed {
      grid-template-columns: minmax(0, 1fr) minmax(220px, 300px);
      grid-template-areas:
        "info feed"
        "player feed"
        "desc feed"
        "comment feed";
    }
    column-gap: 20px;
    align-items: start;
    > .info {
      grid-area: info;
      min-width: 0;
    }
    > .player {
      grid-area: player;
    }
    > .desc {
      grid-area: desc;
      min-width: 0;
    }
    > .comment {
      grid-area: comment;
      min-width: 0;
    }
  }
  .hls-quality {
    width: 100px;
    margin: 8px 0 0 auto;
  }
  .player-state {
    position: absolute;
    inset: 0;
    z-index: 3;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    background: var(--background-hex);
  }
  .player {
    min-width: 0;
    position: relative;
    width: 100%;
    border-radius: 12px;
    overflow: hidden;
    min-height: 200px;
    :deep(video) {
      display: block;
      width: 100%;
    }
    :deep(.plyr) {
      height: 100%;
      width: 100%;
      max-height: 520px;
      border-radius: 12px;
      .plyr__control {
        &.plyr__control--overlaid {
          opacity: 1;
          background-color: rgba(var(--primary), 0.26);
          backdrop-filter: blur(10px);
        }
        &:hover {
          background-color: rgba(var(--primary), 0.56);
        }
      }
    }
    // &.hidden {
    //   :deep(.plyr) {
    //     position: fixed;
    //     right: 40px;
    //     bottom: 40px;
    //     width: 400px;
    //     height: auto;
    //     z-index: 999;
    //   }
    // }
  }
  .feed-panel {
    grid-area: feed;
    align-self: start;
    min-width: 0;
    box-sizing: border-box;
    margin-top: 20px;
    padding: 12px;
    border: 1px solid var(--n-border-color);
    border-radius: 12px;
    background: var(--n-color);
  }
  .feed-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
    .n-h3 {
      margin: 0;
    }
  }
  .feed-loading {
    display: grid;
    gap: 8px;
  }
  .feed-list {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 8px;
  }
  .feed-item {
    display: flex;
    gap: 10px;
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
    padding: 6px;
    border: 0;
    border-radius: 8px;
    color: inherit;
    background: transparent;
    text-align: left;
    cursor: pointer;
    transition: background-color 0.2s ease;
    &:hover,
    &.active {
      background: rgba(var(--primary), 0.12);
    }
  }
  .feed-cover {
    flex: 0 0 96px;
    width: 96px;
    height: 54px;
    border-radius: 6px;
    overflow: hidden;
  }
  .feed-item-content {
    display: flex;
    min-width: 0;
    flex-direction: column;
    justify-content: center;
    gap: 4px;
  }
  .feed-name,
  .feed-creator {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .feed-more {
    width: 100%;
    margin-top: 4px;
  }
  .feed-error {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 8px 0;
  }
  @container (max-width: 760px) {
    .video-layout.with-feed {
      grid-template-columns: minmax(0, 1fr);
      grid-template-areas: "info" "player" "desc" "feed" "comment";
      grid-template-rows: auto;
    }
    .feed-panel {
      margin: 0 0 20px;
    }
  }
  .menu {
    height: 40px;
    margin: 20px 0;
    .artist {
      display: flex;
      align-items: center;
      margin-left: 8px;
      cursor: pointer;
      .cover {
        margin-right: 12px;
        width: 40px;
        height: 40px;
      }
      .name {
        display: inline-flex;
        flex-direction: column;
        font-size: 16px;
        font-weight: bold;
        &::after {
          content: "查看详情";
          font-size: 12px;
          font-weight: normal;
          opacity: 0.6;
        }
      }
    }
    .n-button {
      border-radius: 8px;
    }
  }
  .desc {
    padding: 0 6px;
    margin-bottom: 20px;
    .n-divider {
      margin: 12px 0;
    }
    :deep(.n-ellipsis) {
      cursor: pointer;
    }
    .tags {
      margin-top: 4px;
    }
  }
  .comment {
    .title {
      margin-bottom: 20px;
      .n-h {
        display: inline-flex;
        align-items: center;
        margin-bottom: 0;
        .num {
          margin-left: 6px;
          font-size: 14px;
          line-height: 18px;
        }
      }
    }
  }
}
</style>

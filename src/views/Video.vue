<!-- 视频 -->
<template>
  <div class="video">
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
    <div v-visible class="player">
      <Transition name="fade" mode="out-in">
        <video :key="`${videoPlatform}-${videoId}`" ref="videoRef" />
      </Transition>
    </div>
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
    <n-divider />
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
</template>

<script setup lang="ts">
import { useDataStore, usePlatformStore, useStatusStore } from "@/stores";
import { getMVUrlStr, videoDetail } from "@/api/video";
import { getComment, getSubComment } from "@/api/comment";
import { usePlayer } from "@/utils/player";
// Plyr
import Plyr from "plyr";
import "plyr/dist/plyr.css";
import type { CommentInfo, MVInfo } from "@/types/main.hemusic";
import { FeatureSupportFlag } from "@/api/platform";
import { useI18n } from "vue-i18n";
import Hls from "hls.js";

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
const videoRef = ref<HTMLVideoElement | null>(null);
const videoData = ref<MVInfo | null>(null);
const videoPlayer = ref<Plyr | null>(null);

// 评论数据
const commentLoading = ref<boolean>(true);
const commentData = ref<CommentInfo[]>([]);
const commentType = ref<"hot" | "new">("hot");
const commentPage = ref<number>(1);
const commentHasMore = ref<boolean>(true);
const commentText = computed(() => ({ hot: t("common.hottest"), new: t("common.newest") }));
const commentLastId = ref<string>("");
const commentTotalCount = ref<number>(0);
const hlsRef = ref<Hls | null>(null);

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

// 初始化播放器
const initPlayer = (playerOptions: Plyr.Options) => {
  videoPlayer.value?.destroy();
  if (videoRef.value) videoPlayer.value = new Plyr(videoRef.value, playerOptions);
  // 播放器事件
  videoPlayer.value?.on("playing", () => {
    player.pause();
  });
};

// 获取视频数据
const getVideoData = async (id: string, platform: string) => {
  try {
    if (!id || !platform || !videoRef.value) return;
    // 获取视频详情
    const result = await videoDetail(id, platform);
    videoData.value = result;
    console.log(result);
    const isHLS = Hls.isSupported() && videoData.value?.links?.[0].format == "hls";
    const sources =
      videoData.value?.links?.map((item) => {
        return {
          src:
            item.url || getMVUrlStr(platform, id, item.quality, item.format, true, dataStore.token),
          type: isHLS ? "application/x-mpegURL" : "video/mp4",
          size: item.quality,
        };
      }) || [];
    // 更改播放地址

    if (isHLS) {
      const hls = new Hls();
      hls.loadSource(sources[0].src);
      hls.attachMedia(videoRef.value);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        // Transform available levels into an array of integers (height values).
        const availableQualities = hls.levels.map((l) => l.height);
        const options: Plyr.Options = {
          ...playerOptions,
          quality: {
            default: availableQualities[0],
            options: availableQualities,
            forced: true,
            onChange: (e: number) => {
              const idx = hls.levels.findIndex((level) => level.height == e);
              if (idx > -1 && hls.currentLevel != idx) {
                hls.currentLevel = idx;
              }
            },
          },
        };
        initPlayer(options);
        hlsRef.value = hls;
      });
    } else {
      const options: Plyr.Options = {
        ...playerOptions,
        quality: {
          default: sources[0].size,
          options: sources.map((item) => item.size),
        },
      };

      initPlayer(options);

      if (videoPlayer.value) {
        videoPlayer.value.source = {
          type: "video",
          title: videoData.value?.name,
          sources,
          poster: videoData.value?.cover,
        };
      }
    }
    if (platformStore.isFeatureSupport(platform, FeatureSupportFlag.GetCommentList)) {
      // 获取评论
      getCommentData(id, platform);
    }
  } catch (error) {
    console.error("Error getting video data:", error);
    window.$message.error(t("message.get_video_data_fail"));
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

onUnmounted(() => {
  closeMusic(false);
  videoPlayer.value?.destroy();
  hlsRef.value?.destroy();
});

onMounted(() => {
  closeMusic();
  // 获取视频数据
  getVideoData(videoId.value, videoPlatform.value);
});
</script>

<style lang="scss" scoped>
.video {
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
  .player {
    position: relative;
    width: 100%;
    border-radius: 12px;
    overflow: hidden;
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

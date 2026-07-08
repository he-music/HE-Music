<template>
  <Transition name="fade" mode="out-in">
    <div v-if="data.length > 0" class="cover-list playlist">
      <n-grid :cols="cols" x-gap="20" y-gap="20">
        <n-gi v-for="(item, index) in data" :key="index">
          <div
            class="cover-item"
            @click="goDetail(item)"
            @contextmenu="coverMenuRef?.openDropdown($event, item, 'ranking')"
          >
            <!-- 封面 -->
            <div class="cover">
              <s-image
                :key="item.cover"
                :src="item.cover"
                default-src="/images/album.jpg?asset"
                class="cover-img"
                once
              />
              <template v-if="item.play_count && Number(item.play_count) > 0">
                <!-- 遮罩 -->
                <div class="cover-mask" />
                <!-- 播放量 -->
                <div class="play-count">
                  <SvgIcon name="Play" />
                  <span class="num">{{ n(Number(item.play_count) || 0, "number") }}</span>
                </div>
              </template>
              <!-- 简介 -->
              <div v-if="item.description" class="description">
                <n-text class="text-hidden">
                  {{ item.description }}
                </n-text>
              </div>
              <!-- 播放按钮 -->
              <div class="play-btn" @click.stop>
                <n-button
                  :focusable="false"
                  :loading="item.loading"
                  secondary
                  circle
                  class="play"
                  @click.stop="playList(item)"
                >
                  <template #icon>
                    <SvgIcon :size="32" :name="isPlaying(item) ? 'Pause' : 'Play'" />
                  </template>
                </n-button>
              </div>
            </div>
            <!-- 信息 -->
            <div class="cover-data">
              <n-text class="name text-hidden">
                {{ item.name }}
              </n-text>
            </div>
          </div>
        </n-gi>
      </n-grid>
      <!-- 加载更多 -->
      <n-flex v-if="loadMore" class="load-more" justify="center">
        <n-button :loading="loading" size="large" strong secondary round @click="emit('loadMore')">
          {{ t("common.load_more") }}
        </n-button>
      </n-flex>
      <!-- 右键菜单 -->
      <CoverMenu ref="coverMenuRef" @to-play="playList" />
    </div>
    <div v-else-if="loading" class="cover-list loading playlist">
      <n-grid :cols="cols" x-gap="20" y-gap="20">
        <n-gi v-for="item in loadingNum || 50" :key="item">
          <div class="cover-item">
            <div class="cover">
              <n-skeleton class="cover-img" />
            </div>
            <div class="cover-data">
              <n-skeleton text round :repeat="2" />
            </div>
          </div>
        </n-gi>
      </n-grid>
    </div>
    <!-- 空列表 -->
    <n-empty v-else :description="t('common.list_empty')" size="large" />
  </Transition>
</template>

<script setup lang="ts">
import { useMusicStore, useStatusStore } from "@/stores";
import { debounce } from "lodash-es";
import CoverMenu from "@/components/Menu/CoverMenu.vue";
import { usePlayer } from "@/utils/player";
import type { CoverType, RankingInfo } from "@/types/main.hemusic";
import { getRanking } from "@/api/playlist";
import { useI18n } from "vue-i18n";
const { t, n } = useI18n();

interface Props {
  data: RankingInfo[];
  cols?: string;
  loadMore?: boolean;
  loading?: boolean;
  loadingNum?: number;
  loadingText?: string;
}

withDefaults(defineProps<Props>(), {
  cols: "3 600:3 800:4 900:5 1200:6 1400:7",
});

const emit = defineEmits<{
  // 加载更多
  loadMore: [];
}>();

const player = usePlayer();
const router = useRouter();
const musicStore = useMusicStore();
const statusStore = useStatusStore();

// 右键菜单
const coverMenuRef = ref<InstanceType<typeof CoverMenu> | null>(null);

// 是否处于当前播放列表
// 是否处于当前播放列表
const isPlaying = (item: RankingInfo) =>
  musicStore.isPlayingPlaylist(item.id, item.platform, "ranking") && statusStore.playStatus;

// 查看详情
const goDetail = (item: RankingInfo) => {
  router.push({
    name: "ranking",
    query: { id: item.id, platform: item.platform },
  });
};

// 播放歌单
const playList = debounce(
  async (item: CoverType) => {
    try {
      // 是否为当前列表
      if (musicStore.isPlayingPlaylist(item.id, item.platform, "ranking"))
        return player.playOrPause();
      // 开始加载
      item.loading = true;
      // 获取播放列表
      const list = await getRanking(item.id, item.platform, 1, 1000);
      player.updatePlayList(list.songs, undefined, {
        id: item.id,
        platform: item.platform,
        type: "ranking",
      });
    } catch (error) {
      console.log("Error to play: ", error);
    } finally {
      item.loading = false;
    }
  },
  300,
  { leading: true, trailing: false },
);
</script>

<style lang="scss" scoped>
.cover-list {
  width: 100%;
  padding: 20px 4px;
  .cover-item {
    position: relative;
    height: auto;
    border-radius: 16px;
    z-index: 0;
    transition:
      background-color 0.3s,
      transform 0.3s;
    cursor: pointer;
    .cover {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      aspect-ratio: 1 / 1;
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0px 0px 4px 2px rgba(0, 0, 0, 0.1);
      transition:
        border-radius 0.3s,
        box-shadow 0.3s;
      :deep(img) {
        width: 100%;
        height: 100%;
        // opacity: 0;
        transition: opacity 0.35s ease-in-out;
      }
      .cover-img {
        transition:
          filter 0.3s,
          transform 0.3s;
      }
      .cover-mask {
        position: absolute;
        top: 0;
        left: 0;
        height: 30%;
        width: 100%;
        background: linear-gradient(rgba(0, 0, 0, 0.3), rgba(0, 0, 0, 0));
      }
      .play-count {
        position: absolute;
        display: flex;
        align-items: center;
        top: 10px;
        right: 12px;
        color: #fff;
        font-weight: bold;
        z-index: 2;
        .n-icon {
          color: #fff;
          font-size: 16px;
          margin-right: 4px;
        }
      }
      .description {
        position: absolute;
        left: 0;
        bottom: 0;
        width: 100%;
        padding: 40px 60px 12px 12px;
        background: linear-gradient(rgba(0, 0, 0, 0), rgba(0, 0, 0, 0.6));
        transform: translateY(100%);
        transition: transform 0.3s;
        .n-text {
          color: #fff;
          line-clamp: 3;
          -webkit-line-clamp: 3;
        }
      }
      .play {
        position: absolute;
        right: 10px;
        bottom: 10px;
        transform: translateY(8px);
        opacity: 0;
        transition: all 0.3s;
        background-color: #ffffff66;
        backdrop-filter: blur(6px);
        --n-width: 42px;
        --n-height: 42px;
        .n-icon {
          color: #fff;
        }
        :deep(.n-base-loading) {
          color: #fff;
        }
        &:active {
          background-color: #ffffff33;
        }
      }
      .n-skeleton {
        height: 100%;
      }
    }
    .cover-data {
      display: flex;
      flex-direction: column;
      padding: 12px;
      .name {
        font-size: 16px;
        line-clamp: 2;
        -webkit-line-clamp: 2;
      }
      .tip {
        font-size: 13px;
      }
      .meta {
        font-size: 13px;
        .count {
          &::after {
            content: "·";
            margin: 0 2px;
          }
        }
      }
      .artists {
        margin-top: 2px;
        font-size: 13px;
        .ar {
          display: inline-flex;
          transition: opacity 0.3s;
          opacity: 0.6;
          cursor: pointer;
          &::after {
            content: "/";
            margin: 0 4px;
          }
          &:last-child {
            &::after {
              display: none;
            }
          }
          &:hover {
            opacity: 0.8;
          }
        }
      }
      :deep(.n-skeleton) {
        &:first-child {
          margin-bottom: 12px;
        }
      }
    }
    &:hover {
      background-color: rgba(var(--primary), 0.12);
      .cover {
        .cover-img {
          transform: scale(1.1);
          filter: brightness(0.8);
        }
        .description {
          transform: translateY(0);
        }
        .play {
          transform: translateY(0);
          opacity: 1;
        }
      }
    }
  }
  .load-more {
    margin: 20px 0;
  }
  &.video {
    .cover-item {
      .cover {
        aspect-ratio: 16/9;
      }
    }
  }
  &.loading {
    .cover {
      box-shadow: none;
    }
  }
}
.n-empty {
  margin-top: 60px;
}
</style>

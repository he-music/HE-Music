<template>
  <Transition name="fade" mode="out-in">
    <div v-if="data.length > 0" class="cover-list album">
      <div class="cover-grid">
        <div
          v-for="(item, index) in data"
          :key="index"
          :class="['cover-item', { current: isCurrent(item) }]"
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
      </div>
    </div>
    <div v-else-if="loading" class="cover-list loading album">
      <div class="cover-grid">
        <div v-for="item in loadingNum || 50" :key="item" class="cover-item">
          <div class="cover">
            <n-skeleton class="cover-img" />
          </div>
          <div class="cover-data">
            <n-skeleton text round :repeat="1" />
          </div>
        </div>
      </div>
    </div>
    <!-- 空列表 -->
    <n-empty v-else :description="t('common.list_empty')" size="large" />
  </Transition>
</template>

<script setup lang="ts">
import { useMusicStore, useStatusStore } from "@/stores";
import { debounce } from "lodash-es";
import { usePlayer } from "@/utils/player";
import type { RadioInfo } from "@/types/main.hemusic";
import { useI18n } from "vue-i18n";
const { t } = useI18n();

interface Props {
  data: RadioInfo[];
  cols?: string;
  loading?: boolean;
  loadingNum?: number;
}

withDefaults(defineProps<Props>(), {
  cols: "3 600:3 800:4 900:5 1200:6 1400:7",
});

const player = usePlayer();
const musicStore = useMusicStore();
const statusStore = useStatusStore();

const isCurrent = (item: RadioInfo) =>
  statusStore.radioMode &&
  musicStore.radio.id === item.id &&
  musicStore.radio.platform === item.platform;

// 是否处于当前播放列表
const isPlaying = (item: RadioInfo) => isCurrent(item) && statusStore.playStatus;

// 播放歌单
const playList = debounce(
  async (item: RadioInfo) => {
    try {
      musicStore.radio.name = item.name;
      // 是否为当前列表
      if (isCurrent(item)) return player.playOrPause();
      // 开始加载
      item.loading = true;
      musicStore.radio.id = item.id;
      musicStore.radio.platform = item.platform;
      await player.nextRadio(true);
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
  .cover-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    gap: 20px;
    @media (max-width: 600px) {
      grid-template-columns: repeat(3, 1fr);
      gap: 12px;
    }
  }
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

      .play-btn {
        position: absolute;
        right: 0;
        bottom: 0;
        width: 100%;
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        .play {
          //position: relative;
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
        text-align: center;
        line-clamp: 2;
        -webkit-line-clamp: 2;
        .n-icon {
          color: var(--primary-color);
        }
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
    &.current {
      background-color: rgba(var(--primary), 0.08);
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

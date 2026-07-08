<!-- 播放列表 -->
<template>
  <n-drawer
    id="main-playlist"
    v-model:show="statusStore.playListShow"
    :class="{ 'full-player': statusStore.showFullPlayer }"
    :style="{
      'max-width': isSmallScreen ? '100%' : '400px',
    }"
    :auto-focus="false"
    style="width: 400px"
  >
    <n-drawer-content :native-scrollbar="false" closable>
      <template #header>
        <div class="playlist-header">
          <n-text class="name">
            {{ t("common.play_queue") }}
          </n-text>
          <n-text class="count" depth="3">
            {{ t("common.song_count", { count: dataStore.playList.length }) }}
          </n-text>
        </div>
      </template>
      <Transition name="fade" mode="out-in">
        <!-- 播放列表 -->
        <n-virtual-list
          v-if="dataStore.playList.length"
          ref="playListRef"
          :item-size="80"
          :items="playListData"
          :default-scroll-index="statusStore.playIndex"
          class="playlist-list"
          style="max-height: calc(100vh - 142px)"
        >
          <template #default="{ item: songData, index }">
            <div
              :key="index"
              v-debounce="
                () => {
                  player.togglePlayIndex(index, true);
                  statusStore.playListShow = false;
                }
              "
              :class="['song-item', { on: statusStore.playIndex === index }]"
            >
              <!-- 序号 -->
              <div class="index">
                <n-text
                  v-if="statusStore.playIndex !== index"
                  :class="['num', { big: index + 1 > 9999 }]"
                  depth="3"
                >
                  {{ index + 1 }}
                </n-text>
                <SvgIcon v-else :size="20" name="Music" />
              </div>
              <!-- 信息 -->
              <div class="data">
                <n-text class="name text-hidden">
                  {{ songData.name }}
                </n-text>
                <div v-if="Array.isArray(songData?.artists)" class="artists">
                  <n-text v-for="ar in songData.artists" :key="ar.id" depth="3" class="ar">
                    {{ ar.name }}
                  </n-text>
                </div>
                <div v-else class="artists">
                  <n-text class="ar" depth="3">
                    {{ songData?.artists || t("common.unknown_artist") }}
                  </n-text>
                </div>
              </div>
              <!-- 移除 -->
              <div class="remove" @click.stop="player.removeSongIndex(index)">
                <SvgIcon :size="20" name="Delete" />
              </div>
            </div>
          </template>
        </n-virtual-list>
        <n-empty
          v-else
          :description="t('play.no_songs')"
          class="tip"
          size="large"
          style="margin-top: 60px"
        />
      </Transition>
      <template #footer>
        <n-grid :cols="2" x-gap="16" class="playlist-menu">
          <n-gi>
            <n-button :focusable="false" size="large" strong secondary @click="cleanPlayList">
              <template #icon>
                <SvgIcon name="DeleteSweep" />
              </template>
              {{ t("common.clear_list") }}
            </n-button>
          </n-gi>
          <n-gi>
            <n-button
              :focusable="false"
              size="large"
              strong
              secondary
              @click="scrollToItem(statusStore.playIndex)"
            >
              <template #icon>
                <SvgIcon name="Location" />
              </template>
              {{ t("common.current_play") }}
            </n-button>
          </n-gi>
        </n-grid>
      </template>
    </n-drawer-content>
  </n-drawer>
</template>

<script setup lang="ts">
import { useStatusStore, useDataStore } from "@/stores";
import type { VirtualListInst } from "naive-ui";
import { usePlayer } from "@/utils/player";
import { useI18n } from "vue-i18n";
import { useMobile } from "@/composables/useMobile";
const { t } = useI18n();
const player = usePlayer();
const dataStore = useDataStore();
const statusStore = useStatusStore();
const { isSmallScreen } = useMobile();

const playListRef = ref<VirtualListInst | null>(null);

// 播放列表数据
const playListData = computed(() => {
  return dataStore.playList.map((item, index) => {
    return {
      ...item,
      key: index,
    };
  });
});

// 滚动至指定元素
const scrollToItem = (index: number, behavior: "smooth" | "auto" = "smooth") => {
  playListRef.value?.scrollTo({ index, behavior });
};

// 清空播放列表
const cleanPlayList = () => {
  window.$dialog.warning({
    title: t("common.clear_list"),
    content: t("common.clear_play_list_confirm"),
    positiveText: t("common.ok"),
    negativeText: t("common.cancel"),
    onPositiveClick: () => {
      player.cleanPlayList();
      window.$message.success(t("message.play_list_cleared"));
    },
  });
};
</script>

<style lang="scss" scoped>
.playlist-header {
  display: flex;
  flex-direction: column;
  .count {
    margin-top: 8px;
    font-size: 12px;
  }
}
.playlist-list {
  height: 100%;
  padding: 16px;
  .song-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-direction: row;
    min-height: 64px;
    overflow: hidden;
    border-radius: 8px;
    margin-bottom: 16px;
    padding: 0 12px;
    border: 1px solid transparent;
    background-color: rgba(var(--primary), 0.08);
    cursor: pointer;
    transition:
      transform 0.3s,
      border-color 0.3s,
      box-shadow 0.3s,
      background-color 0.3s;
    .index {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      min-width: 36px;
      margin-right: 12px;
      .num {
        &.big {
          font-size: 12px;
        }
      }
    }
    .data {
      flex: 1;
      display: flex;
      flex-direction: column;
      justify-content: center;
      width: 100%;
      height: 100%;
      padding: 8px 0;
      .artists {
        display: -webkit-box;
        line-clamp: 1;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 1;
        overflow: hidden;
        word-break: break-all;
        .ar {
          font-size: 12px;
          display: inline-flex;
          &::after {
            content: "/";
            margin: 0 4px;
          }
          &:last-child {
            &::after {
              display: none;
            }
          }
        }
      }
    }
    .remove {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 8px;
      border-radius: 8px;
      transition: background-color 0.3s;
      cursor: pointer;
      &:hover {
        background-color: rgba(var(--primary), 0.29);
      }
    }
    &.on {
      border-color: var(--primary-hex);
      background-color: rgba(var(--primary), 0.29);
    }
    &:hover {
      border-color: var(--primary-hex);
    }
  }
}
.playlist-menu {
  height: 40px;
  .n-button {
    width: 100%;
    border-radius: 8px;
  }
}
</style>

<style lang="scss">
#main-playlist {
  --n-border-radius: 12px;
  .n-drawer-header {
    height: 70px;
  }
  .n-scrollbar-content {
    padding: 0;
    height: 100%;
  }
  .n-drawer-footer {
    height: 72px;
    padding: 16px;
  }
  &.full-player {
    --n-color: rgb(var(--main-cover-color));
    --n-close-icon-color: rgba(var(--main-cover-color), 0.58);
    background-color: transparent;
    box-shadow: none;
    .n-drawer-header,
    .n-drawer-footer {
      border: none;
    }
    a,
    span,
    .n-icon {
      color: rgb(var(--main-cover-color));
    }
    .n-button {
      --n-color: rgba(var(--main-cover-color), 0.08);
      --n-color-hover: rgba(var(--main-cover-color), 0.12);
      --n-color-pressed: var(--n-color);
      --n-color-focus: var(--n-color-hover);
    }
    .playlist-list {
      .song-item {
        background-color: rgba(var(--main-cover-color), 0.08);
        &.on {
          border-color: rgb(var(--main-cover-color));
        }
        &:hover {
          border-color: rgb(var(--main-cover-color));
        }
        .num {
          color: rgba(var(--main-cover-color), 0.52);
        }
      }
    }
  }
}
</style>

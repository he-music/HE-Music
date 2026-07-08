<template>
  <div :class="['player-data', settingStore.playerType, { center }]">
    <!-- 名称 -->
    <div class="name">
      <span class="name-text text-hidden">{{ musicStore.playSong.name || "未知曲目" }}</span>
      <!-- 额外信息 -->
      <n-flex v-if="statusStore.playUblock" class="extra-info" align="center">
        <n-popover :show-arrow="false" placement="right" raw>
          <template #trigger>
            <SvgIcon :depth="3" name="CloudLockOpen" size="22" />
          </template>
          <div class="player-tip">
            {{ t("play.unlock_music_tip") }}
          </div>
        </n-popover>
      </n-flex>
    </div>
    <!-- 别名 -->
    <span v-if="musicStore.playSong.alias" class="alia text-hidden">
      {{ musicStore.playSong.alias }}
    </span>
    <n-flex :align="center ? 'center' : undefined" size="small" vertical>
      <!-- 播放状态 -->
      <n-flex
        v-if="settingStore.showPlayMeta && !light"
        class="play-meta"
        size="small"
        align="center"
      >
        <!--        &lt;!&ndash; 音质 &ndash;&gt;-->
        <!--        <span class="meta-item">{{-->
        <!--            statusStore.playUblock || !statusStore.songQuality ? "未知音质" : statusStore.songQuality-->
        <!--          }}</span>-->
        <!-- 歌词模式 -->
        <span class="meta-item">{{ lyricMode }}</span>
        <!-- 是否在线 -->
        <span class="meta-item">
          {{ musicStore.playSong.path ? "LOCAL" : "ONLINE" }}
        </span>
      </n-flex>
      <!-- 歌手 -->
      <div class="artists">
        <SvgIcon :depth="3" name="Artist" size="20" />
        <div v-if="Array.isArray(musicStore.playSong.artists)" class="ar-list">
          <span
            v-for="ar in musicStore.playSong.artists"
            :key="ar.id"
            class="ar"
            @click="
              IsValidId(ar.id) &&
              platformStore.isFeatureSupport(
                musicStore.playSong.platform,
                FeatureSupportFlag.GetSingerInfo,
              ) &&
              jumpPage({
                name: 'artist',
                query: { id: ar.id, platform: musicStore.playSong.platform },
              })
            "
          >
            {{ ar.name }}
          </span>
        </div>
        <div v-else class="ar-list">
          <span class="ar">{{ musicStore.playSong.artists || "未知艺术家" }}</span>
        </div>
      </div>
      <!-- 专辑 -->
      <div class="album">
        <SvgIcon :depth="3" name="Album" size="20" />
        <span
          v-if="isObject(musicStore.playSong.album)"
          class="name-text text-hidden"
          @click="
            IsValidId(musicStore.playSong.album.id) &&
            platformStore.isFeatureSupport(
              musicStore.playSong.platform,
              FeatureSupportFlag.GetAlbumInfo,
            ) &&
            jumpPage({
              name: 'album',
              query: { id: musicStore.playSong.album.id, platform: musicStore.playSong.platform },
            })
          "
        >
          {{ musicStore.playSong.album?.name || "未知专辑" }}
        </span>
        <span v-else class="name-text text-hidden">
          {{ musicStore.playSong.album || "未知专辑" }}
        </span>
      </div>
    </n-flex>
  </div>
</template>

<script setup lang="ts">
import type { RouteLocationRaw } from "vue-router";
import { useMusicStore, usePlatformStore, useSettingStore, useStatusStore } from "@/stores";
import { debounce, isObject } from "lodash-es";
import { IsValidId } from "@/utils/song";
import { FeatureSupportFlag } from "@/api/platform";
import { useI18n } from "vue-i18n";
const { t } = useI18n();

defineProps<{
  center?: boolean;
  // 少量数据模式
  light?: boolean;
}>();

const router = useRouter();
const musicStore = useMusicStore();
const statusStore = useStatusStore();
const settingStore = useSettingStore();
const platformStore = usePlatformStore();

// 当前歌词模式
const lyricMode = computed(() => {
  if (settingStore.showYrc) {
    if (musicStore.isHasYrc) return "YRC";
  }
  return musicStore.isHasLrc ? "LRC" : "NO-LRC";
});
const jumpPage = debounce(
  (go: RouteLocationRaw) => {
    if (!go) return;
    statusStore.showFullPlayer = false;
    router.push(go);
  },
  300,
  {
    leading: true,
    trailing: false,
  },
);
</script>

<style lang="scss" scoped>
.player-data {
  display: flex;
  flex-direction: column;
  width: 70%;
  max-width: 50vh;
  margin-top: 24px;
  padding: 0 2px;
  .n-icon {
    color: rgb(var(--main-cover-color));
  }
  .name {
    position: relative;
    display: flex;
    align-items: center;
    margin-left: 4px;
    .name-text {
      font-size: 26px;
      font-weight: bold;
      line-clamp: 2;
      -webkit-line-clamp: 2;
    }
    .n-icon {
      margin-left: 12px;
      transform: translateY(1px);
      cursor: pointer;
    }
  }
  .alia {
    margin: 6px 0 6px 4px;
    opacity: 0.6;
    font-size: 18px;
    line-clamp: 1;
    -webkit-line-clamp: 1;
  }
  .artists {
    display: flex;
    align-items: center;
    .n-icon {
      margin-right: 4px;
    }
    .ar-list {
      display: -webkit-box;
      line-clamp: 2;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
      overflow: hidden;
      word-break: break-all;
      .ar {
        font-size: 16px;
        opacity: 0.7;
        display: inline-flex;
        transition: opacity 0.3s;
        cursor: pointer;
        &::after {
          content: "/";
          margin: 0 4px;
          transition: none;
        }
        &:last-child {
          &::after {
            display: none;
          }
        }
        &:hover {
          opacity: 1;
        }
      }
    }
  }
  .album,
  .dj {
    font-size: 16px;
    display: flex;
    align-items: center;
    .n-icon {
      margin-right: 4px;
    }
    .name-text {
      opacity: 0.7;
      transition: opacity 0.3s;
      line-clamp: 1;
      -webkit-line-clamp: 1;
      cursor: pointer;
      &:hover {
        opacity: 1;
      }
    }
  }
  .play-meta {
    padding: 4px 4px;
    opacity: 0.6;
    .meta-item {
      font-size: 12px;
      border-radius: 8px;
      padding: 2px 6px;
      border: 1px solid rgba(var(--main-cover-color), 0.6);
    }
  }
  &.record {
    width: 100%;
    padding: 0 80px 0 24px;
    .name {
      .name-text {
        font-size: 30px;
      }
      .extra-info {
        position: absolute;
        right: -34px;
        display: flex;
        align-items: center;
        justify-content: center;
      }
    }
    @media (max-width: 990px) {
      padding: 0 2px;
    }
  }
  &.center {
    align-items: center;
    padding: 0 2px;
    .name {
      text-align: center;
    }
  }
  &.light {
    .name {
      .name-text {
        line-clamp: 1;
        -webkit-line-clamp: 1;
      }
      .extra-info {
        display: none;
      }
    }
    .alia {
      display: none;
    }
  }
}
.player-tip {
  max-width: 240px;
  padding: 12px 20px;
  border-radius: 12px;
  color: rgb(var(--main-cover-color));
  background-color: rgba(var(--main-cover-color), 0.18);
  backdrop-filter: blur(10px);
}
</style>

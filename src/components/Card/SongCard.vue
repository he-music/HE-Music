<template>
  <div class="song-card">
    <div :class="['song-content', { play: songEqual(musicStore.playSong, song) }]">
      <!-- 序号 -->
      <div class="num" @dblclick.stop>
        <n-text v-if="!songEqual(musicStore.playSong, song)" depth="3">
          {{ index + 1 }}
        </n-text>
        <SvgIcon v-else :size="22" name="Music" />
        <!-- 播放暂停 -->
        <SvgIcon
          :size="28"
          :name="statusStore.playStatus ? 'Pause' : 'Play'"
          class="status"
          @click.stop="player.playOrPause()"
        />
        <!-- 播放 -->
        <SvgIcon :size="28" name="Play" class="play" @click.stop="player.addNextSong(song, true)" />
      </div>
      <!-- 标题 -->
      <div class="title">
        <!-- 封面 -->
        <s-image
          v-if="!hiddenCover"
          :key="song.cover || song.path || song.id"
          :src="song.path ? song.cover : getSizeCover(song, 300)"
          class="cover"
          @update:show="localCover"
        />
        <!-- 信息 -->
        <div class="info">
          <!-- 名称 -->
          <div class="name">
            <n-ellipsis
              :line-clamp="1"
              :tooltip="{
                placement: 'top',
                width: 'trigger',
              }"
              class="name-text"
            >
              <n-highlight :text="song.name" :patterns="highlightKeywords || []" />
            </n-ellipsis>
          </div>
          <n-flex :size="4" :wrap="false" class="desc" align="center">
            <!-- 音质 -->
            <n-tag v-if="quality.name" :bordered="false" :type="quality.type || 'default'" round>
              {{ quality.name }}
            </n-tag>
            <slot name="tags" />
            <n-tag
              v-if="song?.mv_id && song?.mv_id != '0'"
              :bordered="false"
              class="mv"
              type="warning"
              round
              @click.stop="
                router.push({
                  name: 'video',
                  query: { id: song.mv_id, platform: song.platform },
                })
              "
            >
              MV
            </n-tag>
            <!-- 歌手 -->
            <div v-if="Array.isArray(song.artists)" class="artists text-hidden">
              <n-text
                v-for="ar in song.artists"
                :key="ar.id"
                class="ar"
                @click.stop="openJumpArtist(song.platform, song.artists)"
              >
                <n-highlight :text="ar.name" :patterns="highlightKeywords || []" />
              </n-text>
            </div>
            <!--          <div v-else-if="song.type === 'radio'" class="artists">-->
            <!--            <n-text class="ar"> 电台节目 </n-text>-->
            <!--          </div>-->
            <div
              v-else
              class="artists text-hidden"
              @click.stop="openJumpArtist(song.platform, song.artists)"
            >
              <n-text class="ar">
                <n-highlight
                  :text="song.artists || t('common.unknown_artist')"
                  :patterns="highlightKeywords || []"
                />
              </n-text>
            </div>
          </n-flex>
          <!--别名-->
          <n-text v-if="song.subtitle" class="alia text-hidden" depth="3">
            {{ song.subtitle }}
          </n-text>
          <div class="details">
            <slot name="details" />
          </div>
        </div>
      </div>
      <!-- 专辑 -->
      <div v-if="!hiddenAlbum && !isSmallScreen" class="album text-hidden">
        <n-text
          v-if="isObject(song.album)"
          class="album-text"
          @click.stop="
            IsValidId(song.album?.id) &&
            platformStore.isFeatureSupport(song.platform, FeatureSupportFlag.GetAlbumInfo) &&
            router.push({
              name: 'album',
              query: { id: song.album?.id, platform: song.platform },
            })
          "
        >
          {{ song.album?.name || "-" }}
        </n-text>
        <n-text v-else class="album-text">
          {{ song.album || "-" }}
        </n-text>
      </div>
      <!-- 操作 -->
      <div class="actions" @click.stop @dblclick.stop>
        <!-- 喜欢歌曲 -->
        <SvgIcon
          v-if="!isSmallScreen"
          :name="dataStore.isLikeSong(song) ? 'Favorite' : 'FavoriteBorder'"
          :size="20"
          @click.stop="toLikeSong(song, !dataStore.isLikeSong(song))"
          @dblclick.stop
        />
        <!-- 移动端菜单 -->
        <SvgIcon v-else name="More" :size="20" @click.stop="emit('show-menu', $event)" />
      </div>
      <!--      &lt;!&ndash; 更新日期 &ndash;&gt;-->
      <!--      <n-text v-if="song.type === 'radio'" class="meta date" depth="3">-->
      <!--        {{ formatTimestamp(song.updateTime) }}-->
      <!--      </n-text>-->
      <!--      &lt;!&ndash; 播放量 &ndash;&gt;-->
      <!--      <n-text v-if="song.type === 'radio'" class="meta" depth="3">-->
      <!--        {{ formatNumber(song.playCount || 0) }}-->
      <!--      </n-text>-->
      <!-- 时长 -->
      <n-text v-if="!isSmallScreen" class="meta" depth="3">
        {{ secondsToTime(song.duration) }}
      </n-text>
      <!-- 大小 -->
      <n-text v-if="!hiddenSize && !isSmallScreen" class="meta size" depth="3">
        {{ formatFileSize(song.size || 0) }}
      </n-text>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useDataStore, useMusicStore, usePlatformStore, useStatusStore } from "@/stores";
import { formatFileSize } from "@/utils/helper";
import { openJumpArtist } from "@/utils/modal";
import { toLikeSong } from "@/utils/auth";
import { isObject } from "lodash-es";
import { secondsToTime } from "@/utils/time";
import { usePlayer } from "@/utils/player";
import blob from "@/utils/blob";
import type { SongInfo } from "@/types/main.hemusic";
import { getSizeCover } from "@/utils/format";
import { TagProps } from "naive-ui";
import { IsValidId, songEqual } from "@/utils/song";
import { FeatureSupportFlag } from "@/api/platform";
import { useI18n } from "vue-i18n";
import { isElectron } from "@/utils/env";
const { t } = useI18n();
import { useMobile } from "@/composables/useMobile";

const props = defineProps<{
  // 歌曲
  song: SongInfo;
  // 索引
  index: number;
  // 隐藏信息
  hiddenCover?: boolean;
  hiddenAlbum?: boolean;
  hiddenSize?: boolean;
  // 仅用于纯文本展示，不改变歌曲数据结构。
  highlightKeywords?: string[];
}>();

const player = usePlayer();
const router = useRouter();
const dataStore = useDataStore();
const musicStore = useMusicStore();
const statusStore = useStatusStore();
const platformStore = usePlatformStore();

// 歌曲数据
const song = toRef(props, "song");

const emit = defineEmits<{
  "show-menu": [event: MouseEvent];
}>();

const { isSmallScreen } = useMobile();

// 加载本地歌曲封面
const localCover = async (show: boolean) => {
  if (!isElectron || !show || !song.value.path) return;
  if (song.value.cover || song.value.cover === "/images/song.jpg?asset") return;
  // 获取封面
  const coverData = await window.electron.ipcRenderer.invoke("get-music-cover", song.value.path);
  if (!coverData) return;
  const { data, format } = coverData;
  const blobURL = blob.createBlobURL(data, format, song.value.path);
  if (blobURL) song.value.cover = blobURL;
};

const getQuality = (song: SongInfo) => {
  if (song.path) {
    switch (song.quality) {
      case "MASTER":
      case "HIRES":
        return {
          name: song.quality,
          type: "error",
        };
      case "SQ":
        return {
          name: song.quality,
          type: "warning",
        };
      case "HQ":
        return {
          name: song.quality,
          type: "success",
        };
      default:
        return {};
    }
  }

  const link = song.links.at(-1);
  if (!link) return {};

  if (link.quality >= 2000) {
    return {
      name: link.name.toUpperCase(),
      type: "error",
    };
  }
  if (link.quality >= 1000) {
    return {
      name: "SQ",
      type: "warning",
    };
  }
  if (link.quality >= 192) {
    return {
      name: "HQ",
      type: "success",
    };
  }
  return {};
};
const quality = getQuality(song.value) as {
  name?: string;
  type: TagProps["type"];
};
</script>

<style lang="scss" scoped>
.song-card {
  height: 100%;
  cursor: pointer;
  .song-content {
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    flex: 1;
    border-radius: 12px;
    border: 2px solid rgba(var(--primary), 0.12);
    background-color: var(--surface-container-hex);
    // transition:
    //   transform 0.1s,
    //   background-color 0.3s var(--n-bezier),
    //   border-color 0.3s var(--n-bezier);
    &.play {
      border-color: rgba(var(--primary), 0.58);
      background-color: rgba(var(--primary), 0.28);
    }
    // &:active {
    //   transform: scale(0.99);
    // }
    &:hover {
      border-color: rgba(var(--primary), 0.58);
      .num {
        .n-text,
        .n-icon {
          opacity: 0;
        }
        .play {
          opacity: 1;
          transform: scale(1);
        }
      }
      &.play {
        .num {
          .play {
            display: none;
          }
          .status {
            opacity: 1;
            transform: scale(1);
          }
        }
      }
    }
  }
  .num {
    position: relative;
    display: flex;
    justify-content: center;
    align-items: center;
    width: 40px;
    min-width: 40px;
    font-weight: bold;
    margin-right: 12px;
    .n-icon {
      color: var(--primary-hex);
      transition:
        opacity 0.3s,
        transform 0.3s;
      :deep(.svg-container) {
        color: var(--primary-hex);
      }
    }
    .status,
    .play {
      position: absolute;
      opacity: 0;
      transform: scale(0.8);
      transition:
        opacity 0.3s,
        transform 0.3s;
      &:active {
        opacity: 0.6 !important;
      }
    }
  }
  .title {
    flex: 1;
    display: flex;
    align-items: center;
    min-width: 0;
    padding: 4px 20px 4px 0;
    .cover {
      width: 50px;
      height: 50px;
      min-width: 50px;
      border-radius: 8px;
      margin-right: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
    }
    .info {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-width: 0;
      .name {
        display: flex;
        flex-direction: row;
        align-items: center;
        font-size: 16px;
        :deep(.name-text) {
          margin-right: 6px;
        }
      }
      .desc {
        margin-top: 2px;
        font-size: 13px;
        .n-tag {
          --n-height: 18px;
          font-size: 9px;
          cursor: pointer;
          pointer-events: none;
          &:last-child {
            margin-right: 0;
          }
        }
        .mv {
          pointer-events: auto;
        }
        .artists {
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
      }
      .alia {
        margin-top: 2px;
        font-size: 12px;
        opacity: 0.8;
      }
      .details {
        display: flex;
        flex-direction: column;
        min-width: 0;
      }
    }
    .sort {
      margin-left: 6px;
      s &::after {
        content: " )";
      }
      &::before {
        content: "( ";
      }
    }
  }
  .album {
    flex: 1;
    line-clamp: 2;
    -webkit-line-clamp: 2;
    padding-right: 20px;
    &:hover {
      .album-text {
        color: var(--primary-hex);
      }
    }
  }
  .actions {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    .n-icon {
      color: var(--primary-hex);
      transition: transform 0.3s;
      cursor: pointer;
      &:hover {
        transform: scale(1.15);
      }
      &:active {
        transform: scale(1);
      }
    }
  }
  .meta {
    width: 50px;
    font-size: 13px;
    text-align: center;
    &.size {
      width: 60px;
    }
    &.date {
      width: 80px;
    }
  }
  &.header {
    border: none;
    background-color: transparent;
    .n-text {
      opacity: 0.6;
    }
    .title {
      position: relative;
      padding: 0 20px 0 0;
      &.has-sort {
        &::after {
          content: "";
          position: absolute;
          opacity: 0;
          top: 0;
          left: -8px;
          width: 100%;
          height: 100%;
          border-radius: 8px;
          background-color: rgba(var(--primary), 0.08);
          transition: opacity 0.3s;
        }
        &:hover {
          &::after {
            opacity: 1;
          }
        }
      }
    }
  }

  :deep(.n-highlight__mark) {
    color: var(--primary-hex);
    background-color: transparent;
    font-weight: 600;
  }
}
</style>

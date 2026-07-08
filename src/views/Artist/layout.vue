<template>
  <div :key="artistId" :class="['artist', { small: listScrolling }]">
    <Transition name="fade" mode="out-in">
      <div v-if="artistDetailData" class="detail">
        <div class="cover">
          <n-image
            :src="artistDetailData.cover"
            :previewed-img-props="{ style: { borderRadius: '8px' } }"
            :preview-src="artistDetailData.cover"
            :render-toolbar="renderToolbar"
            show-toolbar-tooltip
            class="cover-img"
            @load="coverLoaded"
          >
            <template #placeholder>
              <div class="cover-loading">
                <img src="/images/artist.jpg?asset" class="loading-img" alt="loading-img" />
              </div>
            </template>
          </n-image>
          <!-- 封面背板 -->
          <n-image class="cover-shadow" preview-disabled :src="artistDetailData.cover" />
        </div>
        <div class="data">
          <div class="name text-hidden">
            <n-text class="name-text">
              {{ artistDetailData.name || t("common.unknown_artist") }}
            </n-text>
            <n-text v-if="artistDetailData?.alias" class="name-alias" depth="3">
              {{ artistDetailData.alias || t("common.unknown_artist") }}
            </n-text>
          </div>
          <n-collapse-transition :show="!listScrolling" class="collapse">
            <!-- 信息 -->
            <n-flex class="meta">
              <div
                class="item"
                @click="router.push({ name: 'artist-songs', query: { id: artistId, platform } })"
              >
                <SvgIcon name="Music" :depth="3" />
                <n-text>{{ artistDetailData.song_count || 0 }}</n-text>
              </div>
              <div
                class="item"
                @click="router.push({ name: 'artist-albums', query: { id: artistId, platform } })"
              >
                <SvgIcon name="Album" :depth="3" />
                <n-text>{{ artistDetailData.album_count || 0 }}</n-text>
              </div>
              <div
                class="item"
                @click="router.push({ name: 'artist-videos', query: { id: artistId, platform } })"
              >
                <SvgIcon name="Video" :depth="3" />
                <n-text>{{ artistDetailData.mv_count || 0 }}</n-text>
              </div>
            </n-flex>
            <!-- 简介 -->
            <n-text
              v-if="artistDetailData.description"
              class="description text-hidden"
              @click="openDescModal(artistDetailData.description)"
            >
              {{ artistDetailData.description }}
            </n-text>
          </n-collapse-transition>
          <n-flex class="menu" justify="space-between">
            <n-flex class="left" align="flex-end">
              <n-button
                :focusable="false"
                type="primary"
                strong
                secondary
                round
                @click="playAllSongs"
              >
                <template #icon>
                  <SvgIcon name="Play" />
                </template>
                {{ t("common.play") }}
              </n-button>
              <n-button
                :focusable="false"
                strong
                secondary
                round
                @click="toLikeArtist(artistDetailData, !isLikeArtist)"
              >
                <template #icon>
                  <SvgIcon :name="isLikeArtist ? 'Favorite' : 'FavoriteBorder'" />
                </template>
                {{ isLikeArtist ? t("common.cancel_collect") : t("common.collect") }}
              </n-button>
              <!-- 更多 -->
              <n-dropdown :options="moreOptions" trigger="click" placement="bottom-start">
                <n-button :focusable="false" class="more" circle strong secondary>
                  <template #icon>
                    <SvgIcon name="List" />
                  </template>
                </n-button>
              </n-dropdown>
            </n-flex>
          </n-flex>
        </div>
      </div>
      <div v-else class="detail">
        <n-skeleton class="cover" />
        <div class="data">
          <n-skeleton :repeat="4" text />
        </div>
      </div>
    </Transition>
    <!-- 标签页 -->
    <n-tabs v-model:value="artistType" class="tabs" type="segment" @update:value="tabChange">
      <n-tab name="artist-songs">
        {{ t("common.songs") }}
      </n-tab>
      <n-tab name="artist-albums">
        {{ t("common.albums") }}
      </n-tab>
      <n-tab name="artist-videos">
        {{ t("common.videos") }}
      </n-tab>
    </n-tabs>
    <!-- 路由 -->
    <RouterView v-slot="{ Component }">
      <Transition :name="`router-${settingStore.routeAnimation}`" mode="out-in">
        <KeepAlive v-if="settingStore.useKeepAlive">
          <component
            :is="Component"
            :id="artistId"
            ref="componentRef"
            :platform="platform"
            class="router-view"
            @scroll="listScroll"
          />
        </KeepAlive>
        <component
          :is="Component"
          v-else
          :id="artistId"
          ref="componentRef"
          :platform="platform"
          class="router-view"
          @scroll="listScroll"
        />
      </Transition>
    </RouterView>
  </div>
</template>

<script setup lang="ts">
import { copyData, coverLoaded, renderIcon } from "@/utils/helper";
import { renderToolbar } from "@/utils/meta";
import { artistDetail } from "@/api/artist";
import { useDataStore, usePlatformStore, useSettingStore } from "@/stores";
import { toLikeArtist } from "@/utils/auth";
import ArtistSongs from "./songs.vue";
import type { ArtistInfo } from "@/types/main.hemusic";
import { buildSourceUrl } from "@/api/source";
import { FeatureSupportFlag } from "@/api/platform";
import { DropdownOption } from "naive-ui";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { openDescModal } from "@/utils/modal";
const { t } = useI18n();

const router = useRouter();
const dataStore = useDataStore();
const settingStore = useSettingStore();
const platformStore = usePlatformStore();

// 路由元素
const componentRef = ref<InstanceType<typeof ArtistSongs> | null>(null);

// 歌手 ID
const artistId = computed<string>(() => router.currentRoute.value.query.id as string);
const platform = computed<string>(() => router.currentRoute.value.query.platform as string);

// 歌手分类
const artistType = ref<string>((router.currentRoute.value?.name as string) || "artist-songs");

// 歌手数据
const artistDetailData = ref<ArtistInfo | null>(null);

// 列表是否滚动
const listScrolling = ref<boolean>(false);

// 更多操作
// 更多操作
const moreOptions = computed<DropdownOption[]>(() => [
  {
    label: t("menu.copy_share_link"),
    key: "copy",
    show: platformStore.isFeatureSupport(platform.value, FeatureSupportFlag.BuildSourceUrl),
    props: {
      onClick: async () => {
        const { url } = await buildSourceUrl(platform.value, artistId.value, "artist");
        copyData(url, t("menu.share_link_copied"));
      },
    },
    icon: renderIcon("Share"),
  },
  {
    label: t("common.open_source_page"),
    key: "open",
    show: platformStore.isFeatureSupport(platform.value, FeatureSupportFlag.BuildSourceUrl),
    props: {
      onClick: async () => {
        const { url } = await buildSourceUrl(platform.value, artistId.value, "artist");
        window.open(url);
      },
    },
    icon: renderIcon("Link"),
  },
]);

// 是否处于收藏歌手
const isLikeArtist = computed(() => {
  return dataStore.userLikeData.artists.some(
    (ar) =>
      ar.id === artistDetailData.value?.id && ar.platform === artistDetailData.value?.platform,
  );
});

// 获取歌手详情
const getArtistDetail = async (id: string, platform: string) => {
  try {
    if (!id || !platform) return;
    listScrolling.value = false;
    artistDetailData.value = null;
    artistDetailData.value = await artistDetail(id, platform);
  } catch (error) {
    console.error("Error getting artist detail:", error);
    window.$message.error(t("message.get_artist_detail_fail"));
  }
};

// Tabs 改变
const tabChange = (value: string) => {
  router.push({
    name: value,
    query: { id: artistId.value, platform: platform.value },
  });
};

// 播放全部歌曲
const playAllSongs = async () => {
  await router.push({
    name: "artist-songs",
    query: { id: artistId.value, platform: platform.value },
  });
  if (componentRef.value) componentRef.value.playAllSongs();
};

// 列表滚动
const listScroll = (e: Event) => {
  // 滚动高度
  const scrollTop = (e.target as HTMLElement).scrollTop;
  listScrolling.value = scrollTop > 10;
};

onBeforeRouteUpdate((to) => {
  listScrolling.value = false;
  if (to.matched[1]?.name !== "artist") return;
  artistType.value = to.name as string;
  const id = to.query.id as string;
  const pt = to.query.platform as string;
  if ((id && id !== artistId.value) || (pt && pt !== platform.value)) {
    getArtistDetail(id, pt);
  }
});

onMounted(() => getArtistDetail(artistId.value, platform.value));
</script>

<style lang="scss" scoped>
.artist {
  display: flex;
  flex-direction: column;
  height: 100%;
  .detail {
    display: flex;
    height: 240px;
    width: 100%;
    padding: 12px 0 30px 0;
    will-change: height, opacity;
    z-index: 1;
    transition:
      height 0.3s,
      opacity 0.3s;
    .cover {
      position: relative;
      display: flex;
      width: auto;
      height: 100%;
      aspect-ratio: 1 / 1;
      margin-right: 20px;
      border-radius: 50%;
      transition:
        opacity 0.3s,
        margin 0.3s,
        transform 0.3s;
      :deep(img) {
        width: 100%;
        height: 100%;
        opacity: 0;
        transition: opacity 0.35s ease-in-out;
      }
      .cover-img {
        border-radius: 50%;
        overflow: hidden;
        z-index: 1;
        transition:
          opacity 0.3s,
          filter 0.3s,
          transform 0.3s;
      }
      .cover-shadow {
        position: absolute;
        top: 8px;
        height: 100%;
        width: 100%;
        border-radius: 50%;
        filter: blur(12px) opacity(0.6);
        transform: scale(0.92, 0.96);
        z-index: 0;
        background-size: cover;
        aspect-ratio: 1/1;
        :deep(img) {
          opacity: 1;
        }
      }
      &:active {
        transform: scale(0.98);
      }
    }
    .data {
      position: relative;
      display: flex;
      flex-direction: column;
      flex: 1;
      padding-right: 60px;
      :deep(.n-skeleton) {
        height: 30px;
        margin-top: 12px;
        border-radius: 8px;
        &:first-child {
          width: 60%;
          margin-top: 0;
          height: 40px;
        }
      }
      :deep(.n-ellipsis) {
        margin-bottom: 8px;
        padding-left: 4px;
        cursor: pointer;
      }
      .name {
        font-size: 30px;
        font-weight: bold;
        height: 48px;
        transition:
          font-size 0.3s var(--n-bezier),
          color 0.3s var(--n-bezier);
        .name-alias {
          &::before {
            content: "（";
            margin-right: 6px;
          }
          &::after {
            content: "）";
            margin-left: 6px;
          }
        }
      }
      .identify {
        font-size: 16px;
        margin-bottom: 8px;
        padding-left: 4px;
      }
      .collapse {
        position: absolute;
        top: 48px;
        margin: 8px 0;
      }
      .meta {
        margin-bottom: 8px;
        .item {
          display: flex;
          align-items: center;
          cursor: pointer;
          .n-icon {
            font-size: 20px;
            margin-right: 4px;
          }
        }
      }
      .menu {
        position: absolute;
        left: 0;
        bottom: 0;
        width: 100%;
        .n-button {
          height: 40px;
          transition: all 0.3s var(--n-bezier);
        }
        .more {
          width: 40px;
        }
      }
    }
  }
  .tabs {
    height: 40px;
    z-index: 1;
  }
  .router-view {
    flex: 1;
    overflow: hidden;
    &.artist-songs {
      position: absolute;
      width: 100%;
      height: 100%;
      padding-top: 280px;
      transition:
        padding 0.3s,
        transform 0.3s,
        opacity 0.3s;
    }
  }
  &.small {
    .detail {
      height: 120px;
      .cover {
        margin-right: 12px;
        .cover-mask,
        .play-count {
          opacity: 0;
        }
      }
      .data {
        .name {
          font-size: 22px;
        }
        .menu {
          .n-button,
          .search {
            height: 32px;
            --n-font-size: 13px;
            --n-padding: 0 14px;
            --n-icon-size: 16px;
          }
        }
      }
    }
    .router-view {
      &.artist-songs {
        padding-top: 160px;
      }
    }
  }
}
</style>

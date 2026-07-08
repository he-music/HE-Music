<template>
  <div class="search-type comprehensive-search">
    <template v-if="loading">
      <div class="section">
        <SongList :data="[]" loading :show-footer="false" />
      </div>
      <div class="section">
        <PlaylistList :data="[]" loading :loading-num="8" />
      </div>
      <div class="section">
        <AlbumList :data="[]" loading :loading-num="8" />
      </div>
      <div class="section">
        <ArtistList :data="[]" loading />
      </div>
      <div class="section">
        <VideoList :data="[]" loading :loading-num="8" cols="2 600:2 800:3 900:4 1200:5 1400:6" />
      </div>
    </template>
    <template v-else-if="displayResult">
      <!-- 最佳匹配 -->
      <section v-if="hasBestMatch" class="section best-match">
        <div class="best-match-header">
          <n-h3 prefix="bar">
            <n-text>{{ t("search.best_match") }}</n-text>
          </n-h3>
        </div>
        <div :class="['best-match-layout', { 'only-recommendations': !displayPrimary }]">
          <!-- 主要匹配 -->
          <button
            v-if="displayPrimary"
            class="primary-card"
            type="button"
            @click="goDetail(displayPrimary)"
          >
            <div class="primary-cover-wrap">
              <img
                :src="getItemCover(displayPrimary)"
                :alt="getItemName(displayPrimary)"
                width="160"
                height="160"
                loading="lazy"
                class="primary-cover"
              />
            </div>
            <div class="primary-body">
              <div class="primary-heading">
                <n-tag :bordered="false" size="small" type="info" round>
                  {{ t("common.artist") }}
                </n-tag>
                <span class="primary-name">{{ getItemName(displayPrimary) }}</span>
              </div>
              <span v-if="primaryArtistMeta" class="primary-sub">{{ primaryArtistMeta }}</span>
              <div v-if="primaryArtistStats.length" class="primary-stats">
                <span v-for="stat in primaryArtistStats" :key="stat.label" class="primary-stat">
                  <span class="primary-stat-value">{{ stat.value }}</span>
                  <span class="primary-stat-label">{{ stat.label }}</span>
                </span>
              </div>
            </div>
          </button>

          <!-- 推荐匹配 -->
          <div v-if="bestMatchRecommendations.length" class="recommendations">
            <div class="recommendations-title">{{ t("search.related_match") }}</div>
            <button
              v-for="(item, index) in bestMatchRecommendations"
              :key="index"
              class="recommend-card"
              type="button"
              @click="goDetail(item)"
            >
              <div class="recommend-cover-wrap">
                <img
                  :src="getItemCover(item)"
                  :alt="getItemName(item)"
                  width="48"
                  height="48"
                  loading="lazy"
                  class="recommend-cover"
                />
              </div>
              <div class="recommend-body">
                <div class="recommend-meta">
                  <span class="recommend-type">{{
                    t(`common.${getResourceTypeKey(item.resource_type)}`)
                  }}</span>
                  <span class="recommend-name">{{ getItemName(item) }}</span>
                </div>
                <span v-if="getItemSub(item)" class="recommend-sub">{{ getItemSub(item) }}</span>
              </div>
            </button>
          </div>
        </div>
      </section>

      <!-- 歌曲 -->
      <div v-if="displayResult.song?.list?.length" class="section">
        <n-flex class="section-header" align="center" justify="space-between">
          <n-h3 prefix="bar">
            <n-text>{{ t("common.songs") }}</n-text>
          </n-h3>
          <n-button text type="primary" @click="viewMore('song')">
            {{ t("search.view_more") }}
          </n-button>
        </n-flex>
        <SongList
          :data="displayResult.song.list"
          height="auto"
          :show-header="!isSmall"
          doubleClickAction="add"
          disabled-sort
          :hidden-size="true"
          :show-footer="false"
        />
      </div>

      <!-- 歌单 -->
      <div v-if="displayResult.playlist?.list?.length" class="section">
        <n-flex class="section-header" align="center" justify="space-between">
          <n-h3 prefix="bar">
            <n-text>{{ t("common.playlists") }}</n-text>
          </n-h3>
          <n-button text type="primary" @click="viewMore('playlist')">
            {{ t("search.view_more") }}
          </n-button>
        </n-flex>
        <PlaylistList :data="displayResult.playlist.list" />
      </div>

      <!-- 专辑 -->
      <div v-if="displayResult.album?.list?.length" class="section">
        <n-flex class="section-header" align="center" justify="space-between">
          <n-h3 prefix="bar">
            <n-text>{{ t("common.albums") }}</n-text>
          </n-h3>
          <n-button text type="primary" @click="viewMore('album')">
            {{ t("search.view_more") }}
          </n-button>
        </n-flex>
        <AlbumList :data="displayResult.album.list" />
      </div>

      <!-- 歌手 -->
      <div v-if="displayResult.artist?.list?.length" class="section">
        <n-flex class="section-header" align="center" justify="space-between">
          <n-h3 prefix="bar">
            <n-text>{{ t("common.artists") }}</n-text>
          </n-h3>
          <n-button text type="primary" @click="viewMore('artist')">
            {{ t("search.view_more") }}
          </n-button>
        </n-flex>
        <ArtistList :data="displayResult.artist.list" />
      </div>

      <!-- MV -->
      <div v-if="displayResult.mv?.list?.length" class="section">
        <n-flex class="section-header" align="center" justify="space-between">
          <n-h3 prefix="bar">
            <n-text>{{ t("common.videos") }}</n-text>
          </n-h3>
          <n-button text type="primary" @click="viewMore('video')">
            {{ t("search.view_more") }}
          </n-button>
        </n-flex>
        <VideoList :data="displayResult.mv.list" cols="2 600:2 800:3 900:4 1200:5 1400:6" />
      </div>
    </template>
    <n-empty
      v-else
      :description="t('search.no_comprehensive_result', { keyword })"
      style="margin-top: 60px"
      size="large"
    >
      <template #icon>
        <SvgIcon name="SearchOff" />
      </template>
    </n-empty>
  </div>
</template>

<script setup lang="ts">
import { comprehensiveSearch } from "@/api/search";
import SongList from "@/components/List/SongList.vue";
import PlaylistList from "@/components/List/PlaylistList.vue";
import AlbumList from "@/components/List/AlbumList.vue";
import ArtistList from "@/components/List/ArtistList.vue";
import VideoList from "@/components/List/VideoList.vue";
import type {
  ComprehensiveSearchResponse,
  RecommendItem,
  ArtistInfo,
  AlbumInfo,
  PlaylistInfo,
  SongInfo,
  MVInfo,
} from "@/types/main.hemusic";
import { useI18n } from "vue-i18n";
import { useMobile } from "@/composables/useMobile";
const { t } = useI18n();
const { isSmall } = useMobile();

const router = useRouter();

const props = defineProps<{
  keyword: string;
  platform: string;
}>();

const loading = ref<boolean>(true);
const result = ref<ComprehensiveSearchResponse | null>(null);

// best_match 可能为空，统一收口为空值，避免模板直接读取嵌套字段。
const bestMatchPrimary = computed(() => result.value?.best_match?.primary ?? null);
const bestMatchRecommendations = computed(() => result.value?.best_match?.recommendations ?? []);
const primaryArtist = computed(() => bestMatchPrimary.value?.artist ?? null);
const displayPrimary = computed(() => {
  const primary = bestMatchPrimary.value;
  const artist = primary?.artist;
  if (!primary || !artist?.id || !artist.name || !artist.cover) return null;
  return primary;
});
const hasBestMatch = computed(
  () => !!displayPrimary.value || bestMatchRecommendations.value.length > 0,
);
const hasSearchResult = computed(() => {
  const data = result.value;
  if (!data) return false;
  return (
    hasBestMatch.value ||
    data.song?.list?.length > 0 ||
    data.playlist?.list?.length > 0 ||
    data.album?.list?.length > 0 ||
    data.artist?.list?.length > 0 ||
    data.mv?.list?.length > 0
  );
});
const displayResult = computed(() => (hasSearchResult.value ? result.value : null));
const primaryArtistMeta = computed(() => {
  const artist = primaryArtist.value;
  if (!artist) return "";
  return artist.alias || artist.description || "";
});
const primaryArtistStats = computed(() => {
  const artist = primaryArtist.value;
  if (!artist) return [];
  return [
    { label: t("common.songs"), value: artist.song_count },
    { label: t("common.albums"), value: artist.album_count },
    { label: t("common.videos"), value: artist.mv_count },
  ].filter((item) => item.value);
});

// 获取综合搜索结果
const getSearchResult = async () => {
  loading.value = true;
  try {
    result.value = await comprehensiveSearch(props.keyword, props.platform);
  } finally {
    loading.value = false;
  }
};

// resource_type 到 i18n key 的映射
const getResourceTypeKey = (type: string): string => {
  const map: Record<string, string> = {
    artist: "artist",
    playlist: "playlist",
    album: "album",
    song: "song",
    mv: "video",
  };
  return map[type] || type;
};

// 获取推荐项的展示数据
const getItemCover = (item: RecommendItem): string => {
  const data = getRecommendData(item);
  return data ? (data as { cover?: string }).cover || "" : "";
};

const getItemName = (item: RecommendItem): string => {
  const data = getRecommendData(item);
  return data ? (data as { name?: string }).name || "" : "";
};

const getItemSub = (item: RecommendItem): string => {
  const data = getRecommendData(item);
  if (!data) return "";
  switch (item.resource_type) {
    case "song":
    case "album": {
      const artists = (data as SongInfo | AlbumInfo).artists;
      if (Array.isArray(artists)) {
        return artists.map((a) => a.name).join(" / ");
      }
      return "";
    }
    case "playlist":
      return (data as PlaylistInfo).creator || "";
    case "artist":
      return (data as ArtistInfo).alias || (data as ArtistInfo).description || "";
    case "mv":
      return (data as MVInfo).creator || "";
    default:
      return "";
  }
};

const getRecommendData = (item: RecommendItem) => {
  switch (item.resource_type) {
    case "artist":
      return item.artist;
    case "playlist":
      return item.playlist;
    case "album":
      return item.album;
    case "song":
      return item.song;
    case "mv":
      return item.mv;
    default:
      return null;
  }
};

// 跳转详情页
const goDetail = (item: RecommendItem) => {
  const data = getRecommendData(item);
  if (!data) return;
  const id = (data as { id?: string }).id;
  const platform = (data as { platform?: string }).platform;
  if (!id || !platform) return;
  switch (item.resource_type) {
    case "song":
      // 歌曲不跳详情页，直接播放或不做操作
      break;
    case "playlist":
      router.push({ name: "playlist", query: { id, platform } });
      break;
    case "album":
      router.push({ name: "album", query: { id, platform } });
      break;
    case "artist":
      router.push({ name: "artist", query: { id, platform } });
      break;
    case "mv":
      router.push({ name: "video", query: { id, platform } });
      break;
  }
};

// 查看更多 → 跳转对应 tab
const viewMore = (type: string) => {
  router.push({
    name: "search",
    query: { keyword: props.keyword, type, platform: props.platform },
  });
};

onMounted(() => {
  getSearchResult();
});
</script>

<style lang="scss" scoped>
.comprehensive-search {
  .section {
    margin-bottom: 24px;
  }

  .section-header {
    margin-bottom: 12px;
  }

  // 最佳匹配
  .best-match {
    margin-bottom: 28px;

    .best-match-header {
      margin-bottom: 12px;
    }

    .best-match-layout {
      display: grid;
      grid-template-columns: minmax(0, 1.1fr) minmax(240px, 0.9fr);
      gap: 12px;
      align-items: stretch;

      &.only-recommendations {
        grid-template-columns: 1fr;
      }
    }

    .primary-card {
      display: flex;
      align-items: center;
      gap: 18px;
      width: 100%;
      min-height: 148px;
      padding: 16px;
      border-radius: 8px;
      background: var(--surface-container-hex);
      border: 1px solid rgba(var(--primary), 0.16);
      cursor: pointer;
      text-align: left;
      color: inherit;
      font: inherit;
      transition:
        border-color 0.2s ease,
        background-color 0.2s ease,
        transform 0.2s ease;

      &:hover {
        border-color: rgba(var(--primary), 0.42);
        background: rgba(var(--primary), 0.08);
      }

      &:active {
        transform: translateY(1px);
      }

      &:focus-visible {
        outline: 2px solid rgba(var(--primary), 0.7);
        outline-offset: 2px;
      }

      .primary-cover-wrap {
        flex-shrink: 0;
        width: 116px;
        height: 116px;
        border-radius: 8px;
        overflow: hidden;
        background: rgba(var(--primary), 0.06);
      }
      .primary-cover {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }

      .primary-body {
        display: flex;
        flex-direction: column;
        gap: 8px;
        min-width: 0;
        flex: 1;

        .primary-heading {
          display: flex;
          align-items: center;
          gap: 10px;
          min-width: 0;
        }

        .primary-name {
          min-width: 0;
          font-size: 20px;
          font-weight: 700;
          line-height: 1.3;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }
        .primary-sub {
          font-size: 14px;
          color: var(--n-text-color-3);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .primary-stats {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          margin-top: 4px;
        }

        .primary-stat {
          display: inline-flex;
          align-items: baseline;
          gap: 4px;
          padding: 4px 8px;
          border-radius: 6px;
          background: rgba(var(--primary), 0.08);
          line-height: 1.2;
        }

        .primary-stat-value {
          color: var(--primary-hex);
          font-size: 14px;
          font-weight: 700;
        }

        .primary-stat-label {
          color: var(--n-text-color-3);
          font-size: 12px;
        }
      }
    }

    .recommendations {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 0;
      padding: 8px;
      border-radius: 8px;
      background: var(--surface-container-hex);
    }

    .recommendations-title {
      padding: 0 6px 4px;
      color: var(--n-text-color-3);
      font-size: 12px;
      line-height: 1.4;
    }

    .recommend-card {
      display: flex;
      align-items: center;
      gap: 10px;
      min-height: 52px;
      padding: 6px;
      border: 0;
      border-radius: 6px;
      background: transparent;
      cursor: pointer;
      text-align: left;
      color: inherit;
      font: inherit;
      transition: background-color 0.2s ease;

      &:hover {
        background: rgba(var(--primary), 0.08);
      }

      &:active {
        background: rgba(var(--primary), 0.14);
      }

      &:focus-visible {
        outline: 2px solid rgba(var(--primary), 0.7);
        outline-offset: 2px;
      }

      .recommend-cover-wrap {
        flex-shrink: 0;
        width: 48px;
        height: 48px;
        border-radius: 8px;
        overflow: hidden;
        background: rgba(var(--primary), 0.06);
      }
      .recommend-cover {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }

      .recommend-body {
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 0;
        flex: 1;

        .recommend-meta {
          display: flex;
          align-items: center;
          gap: 8px;
          min-width: 0;
        }

        .recommend-type {
          flex-shrink: 0;
          padding: 1px 6px;
          border-radius: 4px;
          background: rgba(var(--primary), 0.12);
          color: var(--primary-hex);
          font-size: 11px;
          line-height: 1.5;
        }

        .recommend-name {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 14px;
          font-weight: 500;
        }

        .recommend-sub {
          font-size: 12px;
          color: var(--n-text-color-3);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
      }
    }
  }

  // 适配移动端
  @media (max-width: 860px) {
    .best-match {
      .best-match-layout {
        grid-template-columns: 1fr;
      }

      .primary-card {
        min-height: 0;

        .primary-cover-wrap {
          width: 96px;
          height: 96px;
        }

        .primary-body {
          .primary-name {
            font-size: 18px;
          }
        }
      }

      .recommendations {
        background: transparent;
        padding: 0;
      }
    }
  }

  @media (max-width: 420px) {
    .best-match {
      .primary-card {
        gap: 12px;
        padding: 12px;

        .primary-cover-wrap {
          width: 72px;
          height: 72px;
        }
      }
    }
  }

  // 尊重用户减弱动画偏好
  @media (prefers-reduced-motion: reduce) {
    .best-match {
      .primary-card,
      .recommend-card {
        transition: none;
        &:hover,
        &:active {
          transform: none;
        }
      }
    }
  }
}
</style>

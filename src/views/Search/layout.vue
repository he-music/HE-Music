<template>
  <div :key="searchKeyword" ref="searchPageRef" class="search">
    <template v-if="!platformStore.loginRequired">
      <div class="search-filters">
        <n-tabs :value="searchType" class="tabs" type="segment" @update:value="tabChange">
          <n-tab v-for="tab in searchTabs" :key="tab.type" :name="tab.type">
            {{ t(tab.label) }}
          </n-tab>
        </n-tabs>
        <n-tabs :value="searchPlatform" class="tabs" type="bar" @update:value="platformChange">
          <n-tab
            v-for="platform in supportedPlatforms"
            :key="platform.id"
            :name="platform.id"
            :disabled="platform.status !== 1"
          >
            {{ platform.shortname }}
          </n-tab>
        </n-tabs>
      </div>
      <div class="search-results">
        <KeepAlive>
          <component
            :is="searchComponent"
            v-if="searchComponent && searchPlatform"
            :key="`${searchType}:${searchPlatform}`"
            :keyword="searchKeyword"
            :platform="searchPlatform"
          />
        </KeepAlive>
      </div>
    </template>
    <PlatformAccessEmpty v-else />
  </div>
</template>

<script setup lang="ts">
import { usePlatformStore } from "@/stores";
import PlatformAccessEmpty from "@/components/Page/PlatformAccessEmpty.vue";
import Songs from "@/views/Search/songs.vue";
import Lyrics from "@/views/Search/lyrics.vue";
import Playlists from "@/views/Search/playlists.vue";
import Albums from "@/views/Search/albums.vue";
import Artists from "@/views/Search/artists.vue";
import Videos from "@/views/Search/videos.vue";
import Audiobook from "@/views/Search/audiobook.vue";
import Comprehensive from "@/views/Search/comprehensive.vue";
import { FeatureSupportFlag } from "@/api/platform";
import type { PlatformInfo } from "@/types/main.hemusic";
import { useI18n } from "vue-i18n";
const { t } = useI18n();

const router = useRouter();

const platformStore = usePlatformStore();

const searchPageRef = ref<HTMLElement | null>(null);

// 搜索关键词（从路由派生，响应式）
const searchKeyword = computed(() => router.currentRoute.value.query.keyword as string);

// 搜索分类与平台（从路由派生，响应式——后退/前进时自动更新）
const searchType = computed(
  () => (router.currentRoute.value.query.type as string) || "comprehensive",
);
const searchPlatform = computed(() => (router.currentRoute.value.query.platform as string) || "");

// 切换搜索条件后从新结果顶部开始。
watch(
  [searchKeyword, searchType, searchPlatform],
  () => {
    if (router.currentRoute.value.name !== "search") return;
    searchPageRef.value?.closest<HTMLElement>(".n-scrollbar-container")?.scrollTo({ top: 0 });
  },
  { flush: "post" },
);

// 搜索类型 → FeatureSupportFlag 映射
const typeToFlagMap: Record<string, bigint> = {
  comprehensive: FeatureSupportFlag.ComprehensiveSearch,
  song: FeatureSupportFlag.SearchSong,
  lyric: FeatureSupportFlag.FeatureSupportSearchLyricSong,
  playlist: FeatureSupportFlag.SearchPlaylist,
  album: FeatureSupportFlag.SearchAlbum,
  audiobook: FeatureSupportFlag.SearchAudiobook,
  artist: FeatureSupportFlag.SearchSinger,
  video: FeatureSupportFlag.SearchMV,
};

// 获取指定搜索类型支持的平台列表
const getSupportedPlatforms = (type: string): PlatformInfo[] => {
  const flag = typeToFlagMap[type];
  if (!flag) return [];
  return platformStore.featureSupportList(flag);
};

const searchViews = [
  { type: "comprehensive", label: "common.comprehensive", component: Comprehensive },
  { type: "song", label: "common.songs", component: Songs },
  { type: "playlist", label: "common.playlists", component: Playlists },
  { type: "album", label: "common.albums", component: Albums },
  { type: "audiobook", label: "common.audiobooks", component: Audiobook },
  { type: "artist", label: "common.artists", component: Artists },
  { type: "video", label: "common.videos", component: Videos },
  { type: "lyric", label: "common.lyrics", component: Lyrics },
];
const searchTabs = computed(() =>
  searchViews.filter((tab) => tab.type !== "lyric" || getSupportedPlatforms("lyric").length),
);
const supportedPlatforms = computed(() => getSupportedPlatforms(searchType.value));
const searchComponent = computed(
  () => searchViews.find((tab) => tab.type === searchType.value)?.component,
);

// 校验并修正平台：不合法时回退到第一个可用平台，返回修正后的值
const getValidPlatform = (type: string, platform: string): string => {
  const list = getSupportedPlatforms(type);
  if (list.length === 0) return "";
  if (list.some((p) => p.id === platform)) return platform;
  return list[0].id;
};

// 搜索类型 tab 切换
const tabChange = (value: string) => {
  const validPlatform = getValidPlatform(value, searchPlatform.value);
  router.push({
    name: "search",
    query: { keyword: searchKeyword.value, type: value, platform: validPlatform },
  });
};

// 平台 tab 切换
const platformChange = (value: string) => {
  const validPlatform = getValidPlatform(searchType.value, value);
  router.push({
    name: "search",
    query: { keyword: searchKeyword.value, type: searchType.value, platform: validPlatform },
  });
};

// 路由恢复（浏览器前进/后退）：校验 platform 合法性，不合法则 replace 修正
onBeforeRouteUpdate((to) => {
  if (to.name !== "search") return;
  if (!platformStore.platforms.length) return;
  const type = (to.query.type as string) || "comprehensive";
  const platform = (to.query.platform as string) || "";
  const validPlatform = getValidPlatform(type, platform);
  if (validPlatform !== platform) {
    router.replace({
      name: "search",
      query: { ...to.query, platform: validPlatform },
    });
  }
});

// 平台数据加载完成后，校验当前 URL 中的 platform 是否合法
watch(
  () => platformStore.platforms,
  () => {
    if (!platformStore.platforms.length) return;
    const validPlatform = getValidPlatform(searchType.value, searchPlatform.value);
    if (validPlatform !== searchPlatform.value) {
      router.replace({
        name: "search",
        query: { keyword: searchKeyword.value, type: searchType.value, platform: validPlatform },
      });
    }
  },
  { immediate: true },
);
</script>

<style lang="scss" scoped>
.search {
  width: 100%;
  .search-filters {
    position: sticky;
    top: 0;
    z-index: 20;
    padding-top: 8px;
    background: var(--sticky-surface-background, rgb(var(--background)));
    backdrop-filter: var(--sticky-surface-filter, none);
  }
  .tabs {
    width: 100%;
  }
  .search-results {
    padding-top: 12px;
    padding-bottom: 16px;
  }
}
</style>

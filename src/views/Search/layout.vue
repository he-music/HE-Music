<template>
  <div :key="searchKeyword" class="search">
    <div class="title">
      <n-text class="keyword">
        {{ searchKeyword }}
      </n-text>
      <n-text depth="3">
        {{ t("search.search_result") }}
      </n-text>
    </div>
    <!-- 标签页 -->
    <n-tabs
      :value="searchType"
      class="tabs"
      type="segment"
      animated
      default-value="song"
      @update:value="tabChange"
    >
      <!--      <n-tab name="search-songs"> 单曲 </n-tab>-->
      <!--      <n-tab name="search-playlists"> 歌单 </n-tab>-->
      <!--      <n-tab name="search-artists"> 歌手 </n-tab>-->
      <!--      <n-tab name="search-albums"> 专辑 </n-tab>-->
      <!--      <n-tab name="search-videos"> 视频 </n-tab>-->
      <!--      -->

      <!--      <n-tab name="search-radios"> 播客 </n-tab>-->

      <n-tab-pane
        name="comprehensive"
        :tab="t('common.comprehensive')"
        display-directive="show:lazy"
      >
        <n-tabs
          class="tabs"
          type="bar"
          animated
          :value="searchPlatform"
          @update:value="platformChange"
        >
          <n-tab-pane
            v-for="platform in getSupportedPlatforms('comprehensive')"
            :key="`search-comprehensive-${platform.id}`"
            :name="platform.id"
            :tab="platform.shortname"
            :disabled="platform.status !== 1"
            display-directive="show:lazy"
          >
            <Comprehensive :keyword="searchKeyword" :platform="platform.id" />
          </n-tab-pane>
        </n-tabs>
      </n-tab-pane>
      <n-tab-pane name="song" :tab="t('common.songs')" display-directive="show:lazy">
        <n-tabs
          class="tabs"
          type="bar"
          animated
          :value="searchPlatform"
          @update:value="platformChange"
        >
          <n-tab-pane
            v-for="platform in getSupportedPlatforms('song')"
            :key="`search-song-${platform.id}`"
            :name="platform.id"
            :tab="platform.shortname"
            :disabled="platform.status !== 1"
            display-directive="show:lazy"
          >
            <Songs :keyword="searchKeyword" :platform="platform.id" />
          </n-tab-pane>
        </n-tabs>
      </n-tab-pane>
      <n-tab-pane name="playlist" :tab="t('common.playlists')" display-directive="show:lazy">
        <n-tabs
          class="tabs"
          type="bar"
          animated
          :value="searchPlatform"
          @update:value="platformChange"
        >
          <n-tab-pane
            v-for="platform in getSupportedPlatforms('playlist')"
            :key="`search-playlist-${platform.id}`"
            :name="platform.id"
            :tab="platform.shortname"
            :disabled="platform.status !== 1"
            display-directive="show:lazy"
          >
            <Playlists :keyword="searchKeyword" :platform="platform.id" />
          </n-tab-pane>
        </n-tabs>
      </n-tab-pane>
      <n-tab-pane name="album" :tab="t('common.albums')" display-directive="show:lazy">
        <n-tabs
          class="tabs"
          type="bar"
          animated
          :value="searchPlatform"
          @update:value="platformChange"
        >
          <n-tab-pane
            v-for="platform in getSupportedPlatforms('album')"
            :key="`search-album-${platform.id}`"
            :name="platform.id"
            :tab="platform.shortname"
            :disabled="platform.status !== 1"
            display-directive="show:lazy"
          >
            <Albums :keyword="searchKeyword" :platform="platform.id" />
          </n-tab-pane>
        </n-tabs>
      </n-tab-pane>
      <n-tab-pane name="audiobook" :tab="t('common.audiobooks')" display-directive="show:lazy">
        <n-tabs
          class="tabs"
          type="bar"
          animated
          :value="searchPlatform"
          @update:value="platformChange"
        >
          <n-tab-pane
            v-for="platform in getSupportedPlatforms('audiobook')"
            :key="`search-audiobook-${platform.id}`"
            :name="platform.id"
            :tab="platform.shortname"
            :disabled="platform.status !== 1"
            display-directive="show:lazy"
          >
            <Audiobook :keyword="searchKeyword" :platform="platform.id" />
          </n-tab-pane>
        </n-tabs>
      </n-tab-pane>
      <n-tab-pane name="artist" :tab="t('common.artists')" display-directive="show:lazy">
        <n-tabs
          class="tabs"
          type="bar"
          animated
          :value="searchPlatform"
          @update:value="platformChange"
        >
          <n-tab-pane
            v-for="platform in getSupportedPlatforms('artist')"
            :key="`search-artist-${platform.id}`"
            :name="platform.id"
            :tab="platform.shortname"
            :disabled="platform.status !== 1"
            display-directive="show:lazy"
          >
            <Artists :keyword="searchKeyword" :platform="platform.id" />
          </n-tab-pane>
        </n-tabs>
      </n-tab-pane>
      <n-tab-pane name="video" :tab="t('common.videos')" display-directive="show:lazy">
        <n-tabs
          class="tabs"
          type="bar"
          animated
          :value="searchPlatform"
          @update:value="platformChange"
        >
          <n-tab-pane
            v-for="platform in getSupportedPlatforms('video')"
            :key="`search-video-${platform.id}`"
            :name="platform.id"
            :tab="platform.shortname"
            :disabled="platform.status !== 1"
            display-directive="show:lazy"
          >
            <Videos :keyword="searchKeyword" :platform="platform.id" />
          </n-tab-pane>
        </n-tabs>
      </n-tab-pane>
      <n-tab-pane
        v-if="getSupportedPlatforms('lyric').length"
        name="lyric"
        :tab="t('common.lyrics')"
        display-directive="show:lazy"
      >
        <n-tabs
          class="tabs"
          type="bar"
          animated
          :value="searchPlatform"
          @update:value="platformChange"
        >
          <n-tab-pane
            v-for="platform in getSupportedPlatforms('lyric')"
            :key="`search-lyric-${platform.id}`"
            :name="platform.id"
            :tab="platform.shortname"
            :disabled="platform.status !== 1"
            display-directive="show:lazy"
          >
            <Lyrics :keyword="searchKeyword" :platform="platform.id" />
          </n-tab-pane>
        </n-tabs>
      </n-tab-pane>
    </n-tabs>

    <!-- 路由 -->
    <!--    <RouterView v-slot="{ Component }">-->
    <!--      <Transition :name="`router-${settingStore.routeAnimation}`" mode="out-in">-->
    <!--        <KeepAlive>-->
    <!--          <component :is="Component" :keyword="searchKeyword" class="router-view" />-->
    <!--        </KeepAlive>-->
    <!--      </Transition>-->
    <!--    </RouterView>-->
  </div>
</template>

<script setup lang="ts">
import { usePlatformStore } from "@/stores";
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

// 搜索关键词（从路由派生，响应式）
const searchKeyword = computed(() => router.currentRoute.value.query.keyword as string);

// 搜索分类与平台（从路由派生，响应式——后退/前进时自动更新）
const searchType = computed(
  () => (router.currentRoute.value.query.type as string) || "comprehensive",
);
const searchPlatform = computed(() => (router.currentRoute.value.query.platform as string) || "");

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
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  overflow: hidden;
  .title {
    margin-top: 12px;
    margin-bottom: 12px;
    font-size: 22px;
    .keyword {
      font-size: 36px;
      font-weight: bold;
      margin-right: 8px;
      line-height: normal;
      word-break: break-all;
    }
    .n-text {
      display: inline-block;
    }

    @media (max-width: 512px) {
      margin-top: 5px;
      margin-bottom: 5px;
      .n-text {
        font-size: 16px;
      }
      .keyword {
        font-size: 24px;
      }
    }
  }
  .tabs {
    width: 100%;
    overflow: hidden;
    :deep(.n-tabs-pane-wrapper) {
      overflow: hidden;
    }
  }
  .router-view {
    flex: 1;
    overflow: hidden;
  }
}
</style>

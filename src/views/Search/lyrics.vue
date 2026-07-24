<template>
  <div class="search-type" style="height: auto">
    <SearchSongList
      v-if="searchResultData.length || loading"
      :data="searchResultData"
      :keyword="keyword"
      :loading="loading"
      :height="songListHeight"
      :show-header="!isSmall"
      allow-full-lyric
      load-more
      @reach-bottom="reachBottom"
    />
    <n-empty
      v-else
      :description="t('search.no_lyric_result', { keyword })"
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
import { searchLyricSong } from "@/api/search";
import SearchSongList from "@/components/List/SearchSongList.vue";
import { useStatusStore } from "@/stores";
import type { SearchSongInfo } from "@/types/main.hemusic";
import { useMobile } from "@/composables/useMobile";
import { useI18n } from "vue-i18n";

const props = defineProps<{
  keyword: string;
  platform: string;
}>();

const { t } = useI18n();
const { isSmall } = useMobile();
const statusStore = useStatusStore();
const hasMore = ref(true);
const loading = ref(true);
const searchPage = ref(1);
const searchResultData = ref<SearchSongInfo[]>([]);

const getSearchResult = async () => {
  loading.value = true;
  try {
    const result = await searchLyricSong({
      platform: props.platform,
      key: props.keyword,
      page_index: searchPage.value,
      page_size: 30,
    });
    hasMore.value = result.has_more;
    searchResultData.value = searchResultData.value.concat(result.list);
  } finally {
    loading.value = false;
  }
};

const reachBottom = () => {
  if (!hasMore.value || loading.value) return;
  searchPage.value++;
  getSearchResult();
};

const songListHeight = computed(() => statusStore.mainContentHeight - 175);

onMounted(getSearchResult);
</script>

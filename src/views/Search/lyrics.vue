<template>
  <AsyncContent
    class="search-type"
    :failed="failed"
    :loading="loading"
    :has-data="!!searchResultData.length"
    @retry="retry"
  >
    <SearchSongList
      v-if="searchResultData.length || loading"
      :data="searchResultData"
      :keyword="keyword"
      :loading="loading"
      :height="songListHeight"
      :show-header="!isSmall"
      allow-full-lyric
      :load-more="hasMore && !failed"
      :show-footer="!failed"
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
  </AsyncContent>
</template>

<script setup lang="ts">
import AsyncContent from "@/components/Page/AsyncContent.vue";
import { usePagedRequest } from "@/composables/usePagedRequest";
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
const {
  data: searchResultData,
  loading,
  failed,
  hasMore,
  loadMore: reachBottom,
  retry,
  reset,
} = usePagedRequest<SearchSongInfo>((page) =>
  searchLyricSong({
    platform: props.platform,
    key: props.keyword,
    page_index: page,
    page_size: 30,
  }),
);
watch(() => [props.keyword, props.platform], reset, { immediate: true });

const songListHeight = computed(() => statusStore.mainContentHeight - 175);
</script>

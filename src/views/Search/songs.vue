<template>
  <AsyncContent
    class="search-type"
    :failed="failed"
    :loading="loading"
    :has-data="!!searchResultData.length"
    @retry="retry"
  >
    <!--    <Transition name="fade" mode="out-in">-->
    <SearchSongList
      v-if="searchResultData.length || loading"
      :data="searchResultData"
      :keyword="keyword"
      :loading="loading"
      :load-more="hasMore && !failed"
      :show-footer="!failed"
      :height="songListHeight"
      @reach-bottom="reachBottom"
      :show-header="!isSmall"
    />
    <n-empty
      v-else
      :description="t('search.no_song_result', { keyword })"
      style="margin-top: 60px"
      size="large"
    >
      <template #icon>
        <SvgIcon name="SearchOff" />
      </template>
    </n-empty>
    <!--    </Transition>-->
  </AsyncContent>
</template>

<script setup lang="ts">
import AsyncContent from "@/components/Page/AsyncContent.vue";
import { usePagedRequest } from "@/composables/usePagedRequest";
import { searchSong } from "@/api/search";
import SearchSongList from "@/components/List/SearchSongList.vue";
import { useStatusStore } from "@/stores";
import type { SearchSongInfo } from "@/types/main.hemusic";
import { useI18n } from "vue-i18n";
import { useMobile } from "@/composables/useMobile";
const { t } = useI18n();
const { isSmall } = useMobile();

const props = defineProps<{
  keyword: string;
  platform: string;
}>();

const statusStore = useStatusStore();

const {
  data: searchResultData,
  loading,
  failed,
  hasMore,
  loadMore: reachBottom,
  retry,
  reset,
} = usePagedRequest<SearchSongInfo>((page) => searchSong(props.keyword, 30, page, props.platform));
watch(() => [props.keyword, props.platform], reset, { immediate: true });

// 列表高度
const songListHeight = computed(() => {
  return statusStore.mainContentHeight - 175;
});
</script>
